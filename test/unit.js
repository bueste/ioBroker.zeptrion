const path = require('path');
const { tests } = require('@iobroker/testing');

// Startet den Adapter gegen ein gemocktes js-controller-Environment und prüft,
// dass er ohne konfigurierte Geräte sauber hochfährt und wieder herunterfährt
// (kein Netzwerkzugriff nötig, da devices: [] Standard ist).
tests.unit(path.join(__dirname, '..'), {
    additionalMockedModules: {}
});
