'use strict';

const deepFreeze = require('deep-freeze');
const axios = require('axios');
const _ = require('lodash');
const chai = require('chai');
const expect = chai.expect;
const VaultClient = require('../src/VaultClient');
const urljoin = require('url-join');

/** Vault JSON API helper (axios; resolves to response body like request-promise `json: true`) */
function vaultHttp(opts) {
    const { method = 'GET', uri, url, body, headers } = opts;
    const finalUrl = uri || url;
    return axios({
        method,
        url: finalUrl,
        data: body,
        headers: {'Content-Type': 'application/json', ...headers},
    }).then((res) => res.data);
}

describe('E2E', function () {

    beforeEach(function () {
        this.bootOpts = deepFreeze({
            api: { url: process.env.VAULT_ADDR || 'http://127.0.0.1:8201'},
            logger: true,
            auth: {
                type: 'token',
                config: {
                    token: '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78', // see docker-compose.yml
                }
            },
        });
    });

    afterEach(function () {
        delete require.cache[require.resolve('config')];
    });

    it('Simple read/write', async function () {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);
        try {
            await vaultClient.write('/secret/tst-val', testData);

            const res = await vaultClient.read('secret/tst-val');
            expect(res.getData()).is.deep.equal(testData);

            const list = await vaultClient.list('secret');
            expect(list.getData().keys).to.include('tst-val');
        } finally {
            vaultClient.shutdown();
        }
    });


    it('Simple write, read, delete, read', async function ()  {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);
        try {
            await vaultClient.write('/secret/tst-val', testData);
            const res = await vaultClient.read('/secret/tst-val');
            expect(res.getData()).is.deep.equal(testData);

            await vaultClient.delete('secret/tst-val');

            let deletedResult;

            try {
                deletedResult = await vaultClient.read('/secret/tst-val');
            } catch (err) {
                const status = err.response && err.response.status;
                expect(status).to.equal(404);
                deletedResult = null;
            }

            expect(deletedResult).is.null;
        } finally {
            vaultClient.shutdown();
        }
    });

    it('Write for ssh backend should return response', async function () {
        const vaultClient = new VaultClient(this.bootOpts);
        try {
            const sshMount = `ssh_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            await vaultClient.write(`/sys/mounts/${sshMount}`, {type: 'ssh'});
            await vaultClient.write(`/${sshMount}/roles/otp_key_role`, {key_type: 'otp', default_user: 'ubuntu', cidr_list: '127.0.0.0/24'});
            const response = await vaultClient.write(`/${sshMount}/creds/otp_key_role`, {ip: '127.0.0.1'});

            expect(response.data.ip).to.equal('127.0.0.1');
            expect(response.data.key_type).to.equal('otp');
            expect(response.data.key).a('string');
            expect(response.data.username).to.equal('ubuntu');
        } finally {
            vaultClient.shutdown();
        }
    });

    it('should fill node-config', async function () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);
        try {
            await vaultClient.write('/secret/a', testData);
            await vaultClient.write('/secret/b', {tst: 'ZZZ'});

            process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-base`;
            const config = require('config');

            expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

            await vaultClient.fillNodeConfig();

            expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: testData.tstStr, aInt: testData.tstInt}, b: 'ZZZ'});
        } finally {
            vaultClient.shutdown();
        }
    });

    it('should handle empty custom-vault-variables', async function () {
        const vaultClient = new VaultClient(this.bootOpts);
        try {
            process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-empty`;
            const config = require('config');

            expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

            await vaultClient.fillNodeConfig();

            expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});
        } finally {
            vaultClient.shutdown();
        }
    });

    describe('Auth Token renewal', function () {
        it('should renew token if needed', async function () {
            this.timeout(6000);

            const testData = {tst: 'testData', tstInt: 12345};

            const tmpTokenRes = await axios({
                method: 'POST',
                url: urljoin(this.bootOpts.api.url, 'v1', 'auth', 'token', 'create-orphan'),
                data: {
                    period: 2,
                    explicit_max_ttl: 10,
                },
                headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
            });
            const tmpToken = tmpTokenRes.data.auth.client_token;

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));
            try {
                await vaultClient.write('/secret/tst-val', testData);

                await new Promise(resolve => {setTimeout(resolve, 2500)});

                const res = await vaultClient.read('secret/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            } finally {
                vaultClient.shutdown();
            }
        });
    });

    describe('Auth backends', function () {
        beforeEach(async function () {
            await vaultHttp({
                method: 'PUT',
                uri: urljoin(this.bootOpts.api.url, 'v1', 'sys', 'policy', 'tst'),
                body: {
                    policy: 'path "*" {\n  capabilities = ["create", "read", "update", "delete", "list", "sudo"]\n}',
                },
                headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
            });
        });

        describe('AppRole', function () {
            let appRoleMount;
            beforeEach(async function () {
                appRoleMount = `approle` + Math.floor(Math.random() * 1000);
                await vaultHttp({
                    method: 'POST',
                    uri: urljoin(this.bootOpts.api.url, 'v1', 'sys', 'auth', appRoleMount),
                    body: {type: 'approle'},
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
                });
            });

            // AppRole login without secret_id is not e2e-tested here: bound_cidr_list must match the
            // address Vault sees (Docker often uses a bridge IP, not 127.0.0.1). See test/auth.appRole.test.js.

            it('with secret ID', async function () {
                const testData = {tst: 'testData', tstInt: 12345};

                await vaultHttp({
                    method: 'POST',
                    uri: urljoin(this.bootOpts.api.url, 'v1', 'auth', appRoleMount, 'role', 'tst'),
                    body: {policies: 'tst'},
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
                });
                let roleId = await vaultHttp({
                    method: 'GET',
                    uri: urljoin(this.bootOpts.api.url, 'v1', 'auth', appRoleMount, 'role', 'tst', 'role-id'),
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
                });
                roleId = roleId.data.role_id;
                let secretId = await vaultHttp({
                    method: 'POST',
                    uri: urljoin(this.bootOpts.api.url, 'v1', 'auth', appRoleMount, 'role', 'tst', 'secret-id'),
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token},
                });
                secretId = secretId.data.secret_id;

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {
                    auth: {
                        type: 'appRole',
                        mount: appRoleMount,
                        config: {role_id: roleId, secret_id: secretId}
                    }
                }));
                try {
                    await vaultClient.write('/secret/tst-val', testData);

                    const res = await vaultClient.read('secret/tst-val');
                    expect(res.getData()).is.deep.equal(testData);
                } finally {
                    vaultClient.shutdown();
                }
            });
        });
    });

});
