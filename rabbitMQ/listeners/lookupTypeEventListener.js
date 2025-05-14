const { subscribeToEvent } = require("message-bus");
const LookupTypeAuditLog = require("../../models/LookupTypeAuditLog");

async function lookupTypeEventListener() {
  console.log("🔍 Initializing lookup type event listener...");

  await subscribeToEvent(
    "lookuptype.created",
    async (data) => {
      console.log("📥 [Audit] LookupType Created Event received:", JSON.stringify(data, null, 2));

      try {
        const now = new Date();
        const auditLog = await LookupTypeAuditLog.create({
          type: "CREATE",
          lookupTypeId: data.lookupTypeId,
          code: data.code,
          lookuptype: data.lookuptype,
          displayname: data.displayname,
          userid: data.userid,
          eventTimestamp: data.timestamp || now,
          auditTimestamp: now,
          metadata: {
            eventType: "lookuptype.created",
            source: "Config-Service",
            originalEventTimestamp: data.timestamp || now,
            auditLogCreationTimestamp: now,
          },
        });

        console.log("✅ LookupType creation audit log saved successfully:", {
          auditLogId: auditLog._id,
          lookupTypeId: data.lookupTypeId,
          code: data.code,
        });
      } catch (err) {
        console.error("❌ Error saving lookup type creation audit log:", {
          error: err.message,
          stack: err.stack,
          data: data,
        });
        throw err;
      }
    },
    "Audit-Service"
  );

  await subscribeToEvent(
    "lookuptype.updated",
    async (data) => {
      console.log("📥 [Audit] LookupType Updated Event received:", JSON.stringify(data, null, 2));

      try {
        const auditLog = await LookupTypeAuditLog.create({
          type: "UPDATE",
          lookupTypeId: data.lookupTypeId,
          code: data.code,
          lookuptype: data.lookuptype,
          displayname: data.displayname,
          userid: data.userid,
          eventTimestamp: data.timestamp || new Date(),
          auditTimestamp: new Date(),
          metadata: {
            eventType: "lookuptype.updated",
            source: "Config-Service",
            originalEventTimestamp: data.timestamp || new Date(),
            auditLogCreationTimestamp: new Date(),
          },
        });

        console.log("✅ LookupType update audit log saved successfully:", {
          auditLogId: auditLog._id,
          lookupTypeId: data.lookupTypeId,
          code: data.code,
        });
      } catch (err) {
        console.error("❌ Error saving lookup type update audit log:", {
          error: err.message,
          stack: err.stack,
          data: data,
        });
        throw err;
      }
    },
    "Audit-Service"
  );

  await subscribeToEvent(
    "lookuptype.deleted",
    async (data) => {
      console.log("📥 [Audit] LookupType Deleted Event received:", JSON.stringify(data, null, 2));

      try {
        const auditLog = await LookupTypeAuditLog.create({
          type: "DELETE",
          lookupTypeId: data.lookupTypeId,
          code: data.code,
          lookuptype: data.lookuptype,
          displayname: data.displayname,
          userid: data.userid,
          eventTimestamp: data.timestamp || new Date(),
          auditTimestamp: new Date(),
          metadata: {
            eventType: "lookuptype.deleted",
            source: "Config-Service",
            originalEventTimestamp: data.timestamp || new Date(),
            auditLogCreationTimestamp: new Date(),
          },
        });

        console.log("✅ LookupType deletion audit log saved successfully:", {
          auditLogId: auditLog._id,
          lookupTypeId: data.lookupTypeId,
          code: data.code,
        });
      } catch (err) {
        console.error("❌ Error saving lookup type deletion audit log:", {
          error: err.message,
          stack: err.stack,
          data: data,
        });
        throw err;
      }
    },
    "Audit-Service"
  );

  console.log("✅ Lookup type event listener initialized successfully");
}

module.exports = lookupTypeEventListener;
