// Candidate fixes applied ONLY to the isolated load DB for A/B runs (never to a real DB).
const d = db.getSiblingDB('splitride_load');
printjson(d.notifications.createIndex({ receiver: 1, createdAt: -1, _id: -1 }));
