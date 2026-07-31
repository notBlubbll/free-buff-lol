function start() {
  const app = require('../index');
  return app.startServer();
}

module.exports = { start };
