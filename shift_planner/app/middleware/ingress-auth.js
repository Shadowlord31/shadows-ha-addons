const db = require('../db/dienstplan');

// Home Assistant Ingress reicht die Identitaet des eingeloggten HA-Users
// ueber Header durch (Supervisor: supervisor/api/ingress.py):
//   X-Remote-User-Id, X-Remote-User-Name, X-Remote-User-Display-Name
// Diese Header existieren nur bei Zugriff ueber die Ingress-URL (Panel in HA),
// nicht bei direktem Port-Zugriff -- das Addon sollte daher NICHT zusaetzlich
// ueber den Host-Port exponiert werden.
//
// Erster jemals angelegter User wird automatisch Admin.

const findOrCreate = db.transaction((haUserId, username, displayName) => {
  let user = db.prepare('SELECT * FROM dp_users WHERE ha_user_id=?').get(haUserId);
  if (user) return user;

  user = db.prepare('SELECT * FROM dp_users WHERE username=? AND ha_user_id IS NULL').get(username);
  if (user) {
    db.prepare('UPDATE dp_users SET ha_user_id=? WHERE id=?').run(haUserId, user.id);
    return db.prepare('SELECT * FROM dp_users WHERE id=?').get(user.id);
  }

  const userCount = db.prepare('SELECT COUNT(*) c FROM dp_users').get().c;
  const isAdmin = userCount === 0 ? 1 : 0;
  const info = db.prepare(
    'INSERT INTO dp_users (ha_user_id,username,display_name,is_admin) VALUES (?,?,?,?)'
  ).run(haUserId, username, displayName || username, isAdmin);
  return db.prepare('SELECT * FROM dp_users WHERE id=?').get(info.lastInsertRowid);
});

function ingressAuth(req, res, next) {
  const haUserId = req.headers['x-remote-user-id'];
  const username = req.headers['x-remote-user-name'];
  const displayName = req.headers['x-remote-user-display-name'];

  if (!haUserId || !username) {
    return next();
  }

  req.dpUser = findOrCreate(haUserId, username, displayName);
  next();
}

module.exports = ingressAuth;
