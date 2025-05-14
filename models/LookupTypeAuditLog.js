const mongoose = require("mongoose");

const lookupTypeAuditLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ["CREATE", "UPDATE", "DELETE"] },
    lookupTypeId: { type: mongoose.Schema.Types.ObjectId, required: true },
    code: { type: String, required: true },
    lookuptype: { type: String, required: true },
    displayname: { type: String },
    oldValues: { type: mongoose.Schema.Types.Mixed, default: null },
    newValues: { type: mongoose.Schema.Types.Mixed, default: null },
    userid: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata: {
      eventType: { type: String, required: true },
      source: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields
  }
);

module.exports = mongoose.model("LookupTypeAuditLog", lookupTypeAuditLogSchema);
