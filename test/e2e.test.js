'use strict';
const deepFreeze = require('deep-freeze');
const axios = require('axios');
const _ = require('lodash');
const chai = require('chai');

const loadVault = require('./vaultLoader');
const VaultClient = require('../src/VaultClient');
const VAULT_ADDR = 'http://127.0.0.1:8201/';

const expect = chai.expect;

describe('E2E', function () {

    beforeEach(function* () {
        this.vaultServer = yield loadVault(VAULT_ADDR);

        this.bootOpts = deepFreeze({
            api: { url: VAULT_ADDR },
            logger: false,
            auth: {
                type: 'token',
                config: {
                    token: this.vaultServer.rootToken,
                }
            },
        });
    });

    afterEach(function* () {
        yield this.vaultServer.kill();
        delete require.cache[require.resolve('config')];
    });

    it('Simple read/write', function* () {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);

        yield vaultClient.write('/kv-v1/tst-val', testData);

        const res = yield vaultClient.read('kv-v1/tst-val');
        expect(res.getData()).is.deep.equal(testData);

        const list = yield vaultClient.list('kv-v1');
        expect(list.getData()).is.deep.equal({keys: ['tst-val']});
    });


    it('Simple write, read, delete, read', function* ()  {
        const testData = {tst: 'testData', tstInt: 12345};

        const vaultClient = new VaultClient(this.bootOpts);

        // write should work.
        const writeRes = yield vaultClient.write('/kv-v1/tst-val', testData);
        const res = yield vaultClient.read('/kv-v1/tst-val');
        expect(res.getData()).is.deep.equal(testData);

        // deleting the key should work 
        const delResult = yield vaultClient.delete('kv-v1/tst-val');
        
        let deletedResult;
        
        // due to the way promise handling works, we have to wait for the error to be thrown.
        try {
            deletedResult = yield vaultClient.read('/kv-v1/tst-val');
        } catch (err) {
            expect(err.statusCode).to.equal(404);
            deletedResult = null;
        }

        expect(deletedResult).is.null;
    });

    it('Write for ssh backend should return response', function *() {
        const vaultClient = new VaultClient(this.bootOpts);
        yield vaultClient.write('/sys/mounts/ssh', {type: 'ssh'});
        yield vaultClient.write('/ssh/roles/otp_key_role', {key_type: 'otp', default_user: 'ubuntu', cidr_list: '127.0.0.0/24'});
        const response = yield vaultClient.write('/ssh/creds/otp_key_role', {ip: '127.0.0.1'});

        expect(response.data.ip).to.equal('127.0.0.1');
        expect(response.data.key_type).to.equal('otp');
        expect(response.data.key).a('string');
        expect(response.data.username).to.equal('ubuntu');
    });

    it('should fill node-config', function* () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);
        yield vaultClient.write('/kv-v1/a', testData);
        yield vaultClient.write('/kv-v1/b', {tst: 'ZZZ'});
    
        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-base`;
        const config = require('config');
   
        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        yield vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: testData.tstStr, aInt: testData.tstInt}, b: 'ZZZ'});
   });

    it('should handle empty custom-vault-variables', function* () {
        const testData = Object.freeze({tstStr: 'testData', tstInt: 12345});

        const vaultClient = new VaultClient(this.bootOpts);

        process.env.NODE_CONFIG_DIR = `${__dirname}/data/config-empty`;
        const config = require('config');

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});

        yield vaultClient.fillNodeConfig();

        expect(JSON.parse(JSON.stringify(config))).to.deep.equal({deep: {aStr: '', aInt: 0}, b: 'NOT WORKING'});
    });

    describe('Auth Token renewal', function () {
        it('should renew token if needed', function* () {
            this.timeout(6000);

            const testData = {tst: 'testData', tstInt: 12345};

            let tmpToken = yield axios({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/token/create-orphan`, body: {
                period: 2,
                explicit_max_ttl: 10,
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            tmpToken = tmpToken.auth.client_token;

            const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {config: {token: tmpToken}}}));

            yield vaultClient.write('/kv-v1/tst-val', testData);

            yield new Promise(resolve => {setTimeout(() => resolve(), 2500)});

            const res = yield vaultClient.read('kv-v1/tst-val');
            expect(res.getData()).is.deep.equal(testData);
        });
    });

    describe('Auth backends', function () {
        beforeEach(function* () {
            yield rp({method: 'PUT', uri: `${this.bootOpts.api.url}v1/sys/policy/tst`, body: {
                rules: 'path "*" {policy = "sudo"}',
            }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
        });

        describe('AppRole', function () {
            beforeEach(function* () {
                yield rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/sys/auth/approle`, body: {
                    type: 'approle',
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
            });

            it('without secret ID', function* () {
                const testData = {tst: 'testData', tstInt: 12345};


                yield rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/approle/role/tst`, body: {
                    bind_secret_id: 'false',
                    bound_cidr_list: '127.0.0.1/32',
                    policies: 'tst'
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let roleId = yield rp({
                    uri: `${this.bootOpts.api.url}v1/auth/approle/role/tst/role-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {type: 'appRole', config: {role_id: roleId}}}));


                yield vaultClient.write('/kv-v1/tst-val', testData);

                const res = yield vaultClient.read('kv-v1/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });

            it('with secret ID', function* () {
                const testData = {tst: 'testData', tstInt: 12345};

                yield rp({method: 'POST', uri: `${this.bootOpts.api.url}v1/auth/approle/role/tst`, body: {
                    policies: 'tst'
                }, json: true, headers: {'X-Vault-Token': this.bootOpts.auth.config.token}});
                let roleId =  yield rp({
                    uri: `${this.bootOpts.api.url}v1/auth/approle/role/tst/role-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                roleId = roleId.data.role_id;
                let secretId = yield rp({
                    method: 'POST',
                    uri: `${this.bootOpts.api.url}v1/auth/approle/role/tst/secret-id`, json: true,
                    headers: {'X-Vault-Token': this.bootOpts.auth.config.token}
                });
                secretId = secretId.data.secret_id;

                const vaultClient = new VaultClient(_.merge({}, this.bootOpts, {auth: {type: 'appRole', config: {role_id: roleId, secret_id: secretId}}}));


                yield vaultClient.write('/kv-v1/tst-val', testData);

                const res = yield vaultClient.read('kv-v1/tst-val');
                expect(res.getData()).is.deep.equal(testData);
            });
        });
    });

});
