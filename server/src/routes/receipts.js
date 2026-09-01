import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs/promises';
import path from 'node:path';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';
import * as storage from '../storage.js';

const VALID_KINDS = ['receipt', 'invoice'];

// Same four HEIC-family MIME types Task 2 added to media.js's ALLOWED map, for the same
// reason (an iPhone Live Photo must not be silently rejected). No video, no raw PDF upload —
// this route is for camera-captured photos only, per the design spec.
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

// Overridable so tests can exercise the 413 path without uploading a real 500MB file — same
// convention as media.js's own MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 500 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: storage.MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, storage.generateStorageKey(ext));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export default function receiptRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post(
    '/',
    requireRole('accounting', 'owner_admin'),
    upload.single('file'),
    // Same MulterError-translation precedent as media.js: a size-limit rejection carries no
    // .status/.statusCode, so left unhandled it would fall through to a generic 500.
    (err, req, res, next) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: { code: 'file_too_large', message: `File exceeds the ${MAX_UPLOAD_BYTES} byte limit` } });
      }
      next(err);
    },
    asyncRoute(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: { code: 'bad_request', message: 'file is required' } });
      }
      const kind = req.body?.kind;
      if (!VALID_KINDS.includes(kind)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: { code: 'bad_request', message: 'kind must be receipt or invoice' } });
      }

      const detected = await fileTypeFromFile(req.file.path);
      if (!detected || !ALLOWED.has(detected.mime)) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: { code: 'invalid_file_type', message: 'File content does not match an accepted image type' } });
      }

      let receipt;
      try {
        ({ rows: [receipt] } = await pool.query(
          `INSERT INTO receipts (tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, kind, mime_type AS "mimeType", size_bytes AS "sizeBytes", created_at AS "createdAt"`,
          [req.user.tenantId, req.user.id, path.basename(req.file.path), kind, detected.mime, req.file.size],
        ));
      } catch (err) {
        // A verified file must never sit on disk with no DB row pointing at it — same
        // discipline as the reject-and-delete path just above, triggered by a different
        // failure point (a DB error after verification already passed, e.g. a connection
        // blip or constraint violation).
        await fs.unlink(req.file.path).catch(() => {});
        throw err;
      }

      await writeAudit(pool, {
        tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'upload',
        targetType: 'receipt', targetId: receipt.id, metadata: { kind },
      });

      res.status(201).json(receipt);
    }),
  );

  router.get('/', requireRole('accounting', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.kind, r.mime_type AS "mimeType", r.size_bytes AS "sizeBytes",
              r.uploaded_by AS "uploadedBy", u.display_name AS "uploadedByName",
              r.created_at AS "createdAt"
       FROM receipts r
       JOIN users u ON u.id = r.uploaded_by
       WHERE r.tenant_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  router.get('/:id', requireRole('accounting', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT storage_key, mime_type FROM receipts WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'receipt not found' } });
    }
    res.type(rows[0].mime_type);
    res.sendFile(storage.resolveMediaPath(rows[0].storage_key));
  }));

  router.delete('/:id', requireRole('accounting', 'owner_admin'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM receipts WHERE id = $1 AND tenant_id = $2 RETURNING storage_key`,
      [req.params.id, req.user.tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'receipt not found' } });
    }
    try {
      await fs.unlink(storage.resolveMediaPath(rows[0].storage_key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'delete',
      targetType: 'receipt', targetId: req.params.id, metadata: {},
    });

    res.status(204).end();
  }));

  return router;
}
