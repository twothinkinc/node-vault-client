'use strict';

const axios = require('axios');
const urljoin = require('url-join');
const _ = require('lodash');

class VaultApiClient {
    /**
     * @param {Object} config
     * @param {String} config.url - the url of the vault server
     * @param {String} config.requestOptions - additional options to pass on to the request http client
     * @param {String} [config.apiVersion='v1']
     * @param {Object} logger
     */
    constructor(config, logger) {
        this.__config = _.defaultsDeep(_.cloneDeep(config), {
            apiVersion: 'v1',
        });

        this._logger = logger;
    }

    async makeRequest(method, path, data, headers) {
        data = data === undefined ? null : data;
        headers = headers === undefined ? {} : headers;
          
        const requestOptions = {
            method: method,
            data: data === null ? undefined : data,
            uri: urljoin(this.__config.apiVersion, path),
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            ...this.__config.requestOptions
        };

        const axiosInstance = axios.create({baseURL: this.__config.url});

        // redirect handling
        axiosInstance.interceptors.response.use(
            response => response,
            error => {
                if (error.response && [301, 302].includes(error.response.status)) {
                    const redirectUrl = error.response.headers.location;
                    return axiosInstance.request({
                        method: requestOptions.method,
                        url: redirectUrl,
                        data: requestOptions.data,
                        headers: requestOptions.headers
                    });
                }
              return Promise.reject(error);
            }
        );
        
        this._logger.debug(
            'making request: %s %s',
            requestOptions.method,
            requestOptions.uri
        );

        return axiosInstance.request({
            method: requestOptions.method,
            url: requestOptions.uri,
            data: requestOptions.data,
            headers: requestOptions.headers
        }).then((response) => {
            this._logger.debug('%s %s response body:\n%s',
                requestOptions.method,
                requestOptions.uri,
                JSON.stringify(response.data, null, ' ')
            );
            return response.data;
        });
    }
}

module.exports = VaultApiClient;
