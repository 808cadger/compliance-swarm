export async function writeAudit(client, {
  tenantId, actorUserId = null, eventType, targetType = null, targetId = null, metadata = {}, ipAddress = null,
}) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, target_type, target_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, actorUserId, eventType, targetType, targetId, JSON.stringify(metadata), ipAddress],
  );
}
