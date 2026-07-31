function start() {
  const proxy = require('../proxy');
  return proxy.startServer();
}

module.exports = { start };
