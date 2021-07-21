'use strict';

const child_process = require('child_process');

function pKiller(processRef) {
    return new Promise(function (resolve, reject) {
        processRef.on('exit', (/*code, signal*/) => {
            //console.log('child process terminated due to receipt of signal '+signal);
            resolve();
        });
        processRef.on('error', err => {
            reject(err);
        });

        processRef.kill();
    });
}

module.exports = function () {
    return new Promise(function (resolve, reject) {
        // jna: When vault starts up in development mode on newer versions it
        // will automatically start the kv server in secrets mode v2.

        // This breaks these tests which assume vault v1 secrets storage.
        const processRef = child_process.spawn('/usr/local/bin/vault', ['server', '-dev']);

        let dataAcc = '';
        processRef.stdout.on('data', function(data) {
            if (dataAcc === null) {
                return;
            }
            
            // we receive binary data here and accumulate it into a buffer
            dataAcc += data.toString(); 

            const found = dataAcc.match(/Root Token: ([a-z0-9\-\.]+)\n/i);

            if (found !== null) {
                dataAcc = null;

                // We've got a root token now, let's enable the kv1 storage
                const secretsRef = child_process.execSync('/usr/local/bin/vault secrets enable -path="kv-v1" kv');

                resolve({
                    rootToken: found[1],
                    kill: () => pKiller(processRef),
                });
            }
        });

        processRef.on('error', err => {
            reject(err);
        });
    });
};
