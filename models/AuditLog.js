// const mongoose = require("mongoose");

// const auditLogSchema = new mongoose.Schema({
//   type: {
//     type: String,
//     required: true,
//     enum: ["LOGIN", "LOGOUT", "CREATE", "UPDATE", "DELETE"],
//   },
//   source: {
//     type: String,
//     required: true,
//   },
//   event: {
//     type: String,
//     required: true,
//   },
//   userMicrosoftId: {
//     type: String,
//     required: true,
//   },
//   userEmail: {
//     type: String,
//     required: true,
//   },
//   userLastLogin: {
//     type: Date,
//     required: true,
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now,
//   },
// });

// module.exports = mongoose.model("AuditLog", auditLogSchema);
