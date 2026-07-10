const path = require('path');
const { tests } = require('@iobroker/testing');

// Prüft io-package.json / package.json auf Konsistenz und Pflichtfelder
// (Version gleich, Lizenz vorhanden, keywords ok, etc.) - Standard-Check
// aus dem ioBroker Adapter-Repository-Checker-Ökosystem.
tests.packageFiles(path.join(__dirname, '..'));
