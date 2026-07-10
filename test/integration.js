const path = require('path');
const { tests } = require('@iobroker/testing');

// Integrationstest: startet einen echten (temporären) js-controller und die Adapterinstanz
// ohne konfigurierte Geräte (native.devices bleibt leer) - prüft nur den sauberen Start,
// da echte zeptrion-Hardware im CI nicht verfügbar ist.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Adapter startet ohne konfigurierte Geräte', (getHarness) => {
            it('sollte ohne Fehler starten und wieder stoppen', function () {
                this.timeout(30000);
                const harness = getHarness();
                return harness.startAdapterAndWait().then(() => {
                    return harness.stopAdapter();
                });
            });
        });
    }
});
