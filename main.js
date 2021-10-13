"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const descriptions = require("./lib/descriptions");

class Renault extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "renault",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.deviceArray = [];
        this.json2iob = new Json2iob(this);
        this.ignoreState = [];
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        this.requestClient = axios.create();
        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.country = this.config.country || "de";
        this.session = {};
        //DE API Key
        this.apiKey = "3_7PLksOyBRkHv126x5WhHb-5pqC1qFR8pQjxSeLB6nhAnPERTUlwnYoznHSxwX668";
        this.subscribeStates("*");

        await this.login();

        if (this.session.id_token) {
            await this.getDeviceList();
            await this.updateDevices();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, 3500 * 1000); //7days
        }
    }
    async login() {
        this.session_data = await this.requestClient({
            method: "post",
            url: "https://accounts.eu1.gigya.com/accounts.login",
            headers: {
                "User-Agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                Accept: "*/*",
                "Accept-Language": "de-de",
                "Cache-Control": "no-cache",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data: qs.stringify({
                apikey: this.apiKey,
                format: "json",
                httpStatusCodes: "false",
                loginID: this.config.username,
                password: this.config.password,
                sdk: "js_latest",
                include: "profile,data",
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data.sessionInfo;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        if (!this.session_data) {
            this.log.error("No session found for this account");
            return;
        }
        await this.requestClient({
            method: "post",
            url: "https://accounts.eu1.gigya.com/accounts.getJWT",
            headers: {
                "User-Agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                Accept: "*/*",
                "Accept-Language": "de-de",
                "Cache-Control": "no-cache",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data: qs.stringify({
                format: "json",
                login_token: this.session_data.cookieValue,
                sdk: "js_latest",
                fields: "data.personId,data.gigyaDataCenter",
                apikey: this.apiKey,
                expiration: "3600",
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        await this.requestClient({
            method: "post",
            url: "https://apis.renault.com/myr/api/v1/connection?&country=DE&product=MYRENAULT&locale=de-DE&displayAccounts=MYRENAULT",
            headers: {
                "Content-Type": "application/json",
                Accept: "*/*",
                "User-Agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                apiKey: "Ae9FDWugRxZQAGm3Sxgk7uJn6Q4CGEA2",
                "Accept-Language": "de-de",
                "x-gigya-id_token": this.session.id_token,
            },
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                const filteredAccounts = res.data.currentUser.accounts.filter(function (el) {
                    return el.accountType === "MYRENAULT" && el.accountStatus === "ACTIVE";
                });

                this.account = filteredAccounts[0];
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getDeviceList() {
        await this.requestClient({
            method: "get",
            url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/vehicles?country=" + this.country + "&oms=false",
            headers: {
                apikey: "Ae9FDWugRxZQAGm3Sxgk7uJn6Q4CGEA2",
                "content-type": "application/json",
                accept: "*/*",
                "user-agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                "accept-language": "de-de",
                "x-gigya-id_token": this.session.id_token,
            },
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));

                for (const device of res.data.vehicleLinks) {
                    this.deviceArray.push(device.vin);
                    let name = device.vehicleDetails.modelSCR;
                    if (device.vehicleDetails.model && device.vehicleDetails.model.label) {
                        name += device.vehicleDetails.model.label;
                    }
                    await this.setObjectNotExistsAsync(device.vin, {
                        type: "device",
                        common: {
                            name: name,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(device.vin + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(device.vin + ".general", {
                        type: "channel",
                        common: {
                            name: "General Information",
                        },
                        native: {},
                    });

                    const remoteArray = [
                        { command: "actions/hvac-start", name: "True = Start, False = Stop" },
                        { command: "hvac-temperature", name: "HVAC Temperature", type: "number", role: "value" },
                        { command: "actions/charging-start", name: "True = Start, False = Stop" },
                        { command: "charge/pause-resume", name: "True = Start, False = Stop" },
                        { command: "charge/start", name: "True = Start, False = Stop" },
                    ];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(device.vin + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.json2iob.parse(device.vin + ".general", device);
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async updateDevices() {
        const curDate = new Date().toISOString().split("T")[0];

        const statusArray = [
            {
                path: "battery-status",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v2/cars/$vin/battery-status?country=" + this.country,
                desc: "Battery status of the car",
            },
            {
                path: "battery-inhibition-status",
                url:
                    "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" +
                    this.account.accountId +
                    "/kamereon/kca/car-adapter/v1/cars/$vin/battery-inhibition-status?country=" +
                    this.country,
                desc: "Battery inhibition status of the car",
            },
            {
                path: "cockpit",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/cockpit?country=" + this.country,
                desc: "Status of the car",
            },
            {
                path: "cockpitv2",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v2/cars/$vin/cockpit?country=" + this.country,
                desc: "Statusv2 of the car",
            },
            {
                path: "charge-mode",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/charge-mode?country=" + this.country,
                desc: "Charge mode of the car",
            },
            {
                path: "hvac-status",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/hvac-status?country=" + this.country,
                desc: "HVAC status of the car",
            },
            {
                path: "hvac-settings",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/hvac-settings?country=" + this.country,
                desc: "HVAC settings of the car",
            },
            {
                path: "charging-settings",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/charging-settings?country=" + this.country,
                desc: "Charging settings of the car",
            },
            {
                path: "charge-history",
                url:
                    "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" +
                    this.account.accountId +
                    "/kamereon/kca/car-adapter/v1/cars/$vin/charge-history?type=day&start=1970-01-01&end=" +
                    curDate +
                    "&country=" +
                    this.country,
                desc: "Charging history of the car",
            },
            {
                path: "charges",
                url:
                    "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" +
                    this.account.accountId +
                    "/kamereon/kca/car-adapter/v1/cars/$vin/charges?start=1970-01-01&end=" +
                    curDate +
                    "&country=" +
                    this.country,
                desc: "Charges of the car",
            },
            {
                path: "lock-status",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/lock-status?country=" + this.country,
                desc: "Lock status of the car",
            },
            {
                path: "res-state",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/res-state?country=" + this.country,
                desc: "Res status of the car",
            },
            {
                path: "location",
                url: "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" + this.account.accountId + "/kamereon/kca/car-adapter/v1/cars/$vin/location?country=" + this.country,
                desc: "Location of the car",
            },
        ];

        const headers = {
            apikey: "Ae9FDWugRxZQAGm3Sxgk7uJn6Q4CGEA2",
            "content-type": "application/json",
            accept: "*/*",
            "user-agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
            "accept-language": "de-de",
            "x-gigya-id_token": this.session.id_token,
        };
        this.deviceArray.forEach(async (vin) => {
            statusArray.forEach(async (element) => {
                if (this.ignoreState.includes(element.path)) {
                    return;
                }
                const url = element.url.replace("$vin", vin);

                await this.requestClient({
                    method: "get",
                    url: url,
                    headers: headers,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        let data = res.data;
                        if (res.data.data && res.data.data.attributes) {
                            data = res.data.data.attributes;
                        }

                        const forceIndex = null;
                        const preferedArrayName = null;

                        this.json2iob.parse(vin + "." + element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName, channelName: element.desc });
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                clearTimeout(this.refreshTokenTimeout);
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshToken();
                                }, 1000 * 60);

                                return;
                            }
                            if (
                                error.response.status === 403 ||
                                error.response.status === 404 ||
                                error.response.status === 500 ||
                                error.response.status === 501 ||
                                error.response.status === 502 ||
                                error.response.status === 400
                            ) {
                                this.ignoreState.push(element.path);
                                this.log.info("Feature not found. Ignore " + element.path + " for updates.");
                                this.log.info(error);
                                error.response && this.log.info(JSON.stringify(error.response.data));
                                return;
                            }
                        }
                        this.log.error(url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            });
        });
    }
    async refreshToken() {
        await this.requestClient({
            method: "post",
            url: "https://accounts.eu1.gigya.com/accounts.getJWT",
            headers: {
                "User-Agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                Accept: "*/*",
                "Accept-Language": "de-de",
                "Cache-Control": "no-cache",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data: qs.stringify({
                format: "json",
                login_token: this.session_data.cookieValue,
                sdk: "js_latest",
                fields: "data.personId,data.gigyaDataCenter",
                apikey: this.apiKey,
                expiration: "3600",
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
            })
            .catch((error) => {
                this.log.error("refresh token failed");
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error("Start relogin in 1min");
                this.reLoginTimeout = setTimeout(() => {
                    this.login();
                }, 1000 * 60 * 1);
            });
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    toCamelCase(string) {
        const camelC = string.replace(/-([a-z])/g, function (g) {
            return g[1].toUpperCase();
        });
        return camelC.charAt(0).toUpperCase() + camelC.slice(1);
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            clearTimeout(this.refreshTimeout);
            clearTimeout(this.reLoginTimeout);
            clearTimeout(this.refreshTokenTimeout);
            clearInterval(this.updateInterval);
            clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                const path = id.split(".")[4];
                const command = path.split("/")[1];
                const data = { data: { type: this.toCamelCase(command), attributes: { action: state.val ? "start" : "cancel" } } };
                if (command === "hvac-start") {
                    const temperatureState = await this.getStateAsync(deviceId + ".remote.hvac-temperature");
                    if (temperatureState) {
                        data.data.attributes.targetTemperature = temperatureState.val ? temperatureState.val : 21;
                    } else {
                        data.data.attributes.targetTemperature = 21;
                    }
                }
                const url =
                    "https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/" +
                    this.account.accountId +
                    "/kamereon/kca/car-adapter/v1/cars/" +
                    deviceId +
                    "/" +
                    path +
                    "?country=" +
                    this.country;
                this.log.debug(JSON.stringify(data));
                this.log.debug(url);
                await this.requestClient({
                    method: "post",
                    url: url,
                    headers: {
                        apikey: "Ae9FDWugRxZQAGm3Sxgk7uJn6Q4CGEA2",
                        "content-type": "application/vnd.api+json",
                        accept: "*/*",
                        "user-agent": "MYRenault/39 CFNetwork/1312 Darwin/21.0.0",
                        "accept-language": "de-de",
                        "x-gigya-id_token": this.session.id_token,
                    },
                    data: data,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                    });
                clearTimeout(this.refreshTimeout);
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateDevices();
                }, 10 * 1000);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Renault(options);
} else {
    // otherwise start the instance directly
    new Renault();
}
