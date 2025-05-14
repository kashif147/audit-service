const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ["LOGIN", "LOGOUT", "CREATE", "UPDATE", "DELETE"],
  },
  source: {
    type: String,
  },
  event: {
    type: String,
  },
  userMicrosoftId: {
    type: String,
  },
  userEmail: {
    type: String,
  },
  userLastLogin: {
    type: Date,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
