import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs/promises';
import path from 'node:path';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';
import { MEDIA_DIR, generateStorageKey } from '../storage.js';

// Overridable so tests can exercise the 413 path without uploading a real 500MB file.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 500 * 1024 * 1024;

const ALLOWED = new Map([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/heic', 'photo'],
  ['image/heif', 'photo'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, generateStorageKey(ext));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

async function loadWalkthroughForCaller(pool, walkthroughId, user) {
  const scopedToSelf = user.role === 'supervisor';
  const { rows } = await pool.query(
    `SELECT id FROM walkthroughs WHERE id = $1 AND tenant_id = $2 AND ($3 = false OR supervisor_id = $4)`,
    [walkthroughId, user.tenantId, scopedToSelf, user.id],
  );
  return rows[0] ?? null;
}

export default function mediaRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post(
    '/walkthroughs/:id/media',
    requireRole('supervisor', 'owner_admin'),
    upload.single('file'),
    // multer calls next(err) with a MulterError (no .status/.statusCode) when the size limit
    // is exceeded; the shared terminal handler in app.js only recognizes 4xx errors that carry
    // one of those properties, so left unhandled this would fall through to a generic 500.
    // Handled here inline — same precedent as users.js translating Postgres's 23505 to a 409
    // at the route that produces it, rather than teaching the shared handler domain-specific
    // error codes. Anything other than LIMIT_FILE_SIZE (a different multer error, or anything
    // else) is re-thrown so it still reaches the shared handler unchanged.
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
      const walkthrough = await loadWalkthroughForCaller(pool, req.params.id, req.user);
      if (!walkthrough) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(404).json({ error: { code: 'not_found', message: 'walkthrough not found' } });
      }

      const detected = await fileTypeFromFile(req.file.path);
      const kind = detected && ALLOWED.get(detected.mime);
      if (!kind) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: { code: 'invalid_file_type', message: 'File content does not match an accepted photo or video type' } });
      }

      const tags = Array.isArray(req.body?.tags) ? req.body.tags : (req.body?.tags ? [req.body.tags] : []);
      const capturedAt = req.body?.capturedAt ? new Date(req.body.capturedAt) : null;

      const { rows: [media] } = await pool.query(
        `INSERT INTO media (walkthrough_id, tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes, tags, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, kind, mime_type AS "mimeType", size_bytes AS "sizeBytes"`,
        [walkthrough.id, req.user.tenantId, req.user.id, path.basename(req.file.path), kind, detected.mime, req.file.size, tags, capturedAt],
      );

      await writeAudit(pool, {
        tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'upload',
        targetType: 'media', targetId: media.id, metadata: { walkthroughId: walkthrough.id, kind },
      });

      res.status(201).json(media);
    }),
  );

  return router;
}
