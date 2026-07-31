try { require('./index'); console.log('OK') } catch(e) { console.error(e.stack); process.exit(1) }
