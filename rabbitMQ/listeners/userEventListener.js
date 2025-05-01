const { subscribeToEvent } = require("message-bus");

const AuditLog = require("../../models/AuditLog");

async function userEventListener() {
  await subscribeToEvent(
    "user.microsoftAuthenticated",
    async (data) => {
      console.log("📥 [Audit] Event received:", data);

      try {
        await AuditLog.create({
          type: "LOGIN",
          source: "User-Service",
          event: "user.microsoftAuthenticated",
          userMicrosoftId: data.userMicrosoftId,
          userEmail: data.userEmail,
          userLastLogin: data.userLastLogin,
          // payload: data,
        });
        console.log("✅ Audit log saved");
      } catch (err) {
        console.error("❌ Error saving audit log:", err.message);
      }
    },
    "Audit-Service"
  );
}

module.exports = userEventListener;
