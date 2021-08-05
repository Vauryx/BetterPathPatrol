class TokenPatrollerInitalizer {
    constructor() {}

    static initialize() {
        TokenPatrollerInitalizer.hooksOnCanvasInit();
        TokenPatrollerInitalizer.hooksOnReady();
        TokenPatrollerInitalizer.hooksRenderTokenHUD();
        TokenPatrollerInitalizer.hooksControlToken();
        TokenPatrollerInitalizer.hooksDeleteToken();
        //TokenPatrollerInitalizer.hooksPreDeleteAmbientSounds();
        //TokenPatrollerInitalizer.hooksPreUpdateScene();
        let theLayers = Canvas.layers;
        theLayers.terrain = RoutesLayer;

        Object.defineProperty(Canvas, 'layers', {
            get: function () {
                return theLayers
            }
        })
    }

    static hooksOnCanvasInit() {
        Hooks.on("canvasInit", () => {
            if (!game.user.isGM) return;
            let flags = canvas.scene.data.flags;
            if (flags.routes == null) {
                flags.routes = [];
                canvas.scene.update({ flags: flags });
            }
        });
    }

    static hooksOnReady() {
        Hooks.on("ready", async () => {
            if (!game.user.isGM) return;
            canvas.stage.addChild(new RoutesLayer());
            //TokenPatrollerInitalizer._registerSettings();
           // TP.patrolDataManager = new PatrolDataManager();
            TP.tokenPatroller = await TokenPatrollerManager.create();
           // TP.routeLogger = new RoutesKeyLogger();
           // TP.visionHandler = new VisionHandler();
           // TP.audioHandler = new AudioHandler();
           // TP.speechHandler = new SpeechHandler();
        });
    }

    static hooksPreUpdateScene() {
        Hooks.on("preUpdateScene", async (Scene, status, diff, id) => {
            if (status.activate) await TP.tokenPatroller._resetWalk();
        });
    }

    static hooksRenderTokenHUD() {
        Hooks.on("renderTokenHUD", (tokenHUD, html, options) => {
            if (!game.user.isGM) return;
            TokenHud.HUD(tokenHUD.object, html, options);
        });
    }

    static hooksControlToken() {
        Hooks.on("controlToken", (object, controlled) => {
            if (!game.user.isGM) return;
            let tokenId = object.data._id;
            if (controlled) {
                TP.tokenPatroller.livePlotUpdate(tokenId);
            } else {
                let GLOBAL_ROUTES_INDEX = canvas.layers.findIndex(function (element) {
                    return element.constructor.name == "RoutesLayer";
                });
                TP.tokenPatroller._removePlotDrawing(tokenId);
                canvas.layers[GLOBAL_ROUTES_INDEX].deactivate();
                canvas.layers[GLOBAL_ROUTES_INDEX].draw();
            }
        });
    }

    static hooksDeleteToken() {
        Hooks.on("deleteToken", (scene, tokenInfo) => {
            TP.tokenPatroller.deleteToken(tokenInfo._id);
        });
    }

    static hooksPreDeleteAmbientSounds() {
        Hooks.on("preDeleteAmbientSound", (scene, ambientSound, flags, sceneId) => {
            TP.tokenPatroller.deleteAmbientSound(ambientSound.flags.tokenId);
        });
    }

    /*static _registerSettings() {
        TP.PATROLCONFIG.forEach((setting) => {
            game.settings.register(TP.MODULENAME, setting.key, setting.settings);
        });
    }*/
}
class RoutesLayer extends CanvasLayer {
    constructor() {
        super();
        this.objects = null;
    }

    static get layerOptions() {
        return {
            canDragCreate: true,
            snapToGrid: true,
        };
    }

    /**
     * Similar to below, error occurs in the event the GM swaps scenes while the token is displaying. Since this.sceneId is unavailable
     * an error is thrown. Since this is the only known occurance of an error (by this module atleast), the error can be safely disregarded.
     */
    async draw() {
        try {
            await super.removeChildren().forEach((c) => c.destroy({ children: true }));
            await super.draw();
            this.objects = this.addChild(new PIXI.Container());

            let objectData = canvas.scene.data.flags.routes;
            for (let data of objectData) {
                let obj = await this.drawObject(data);
                this.objects.addChild(obj.drawing);
            }
        } catch (error) {}
    }

    activate() {
        super.activate();
    }

    deactivate() {
        super.deactivate();
    }

    async drawObject(data) {
        let obj = new drawRoute(data);
        return obj.showRoute();
    }
}

class TokenPatrollerManager {
    constructor() {
        this.tokenMap;
        this.GLOBAL_ROUTES_INDEX = canvas.layers.findIndex(function (element) {
            return element.constructor.name == "RoutesLayer";
        });
        this.debug = true;
    }

    static async create() {
        const o = new TokenPatrollerManager();
        await o.initializeHashTable();
        await o._resetWalk();
        return o;
    }

    async _resetWalk() {
        for (let [key, res] of Object.entries(this.tokenMap)) {
            res["isWalking"] = false;
        }
        await this._saveAndUpdate(this.tokenMap);
    }

    async _saveAndUpdate(data) {
        this.tokenMap = data;
       // await TP.patrolDataManager.saveMap(this.tokenMap);
    }

    async initializeHashTable() {
      //  this.tokenMap = await TP.patrolDataManager.dataInit();
    }

    async addPlotPoint(tokenId) {
        let token = canvas.tokens.get(tokenId);
        let coord = {
            x: getProperty(token.data, "x"),
            y: getProperty(token.data, "y"),
        };
        if (!coord) return;
        this.updateTokenRoute(tokenId, coord);
        this.livePlotUpdate(tokenId);
        await this.linearWalk(false, tokenId);
        await this.linearWalk(true, tokenId);
    }

    async startPatrol(delay = null, tokenId) {
        delay = delay ? delay : this.delayPeriod;
        let token = canvas.tokens.get(tokenId);
        await this._handleDelayPeriod(delay, tokenId);
        let patrolData = this.tokenMap[tokenId];

        if (!patrolData) return;

        this._updatelastRecordedLocation(undefined, token);
        if (patrolData.isWalking) return;
        else patrolData.isWalking = true;
        let cycle = this.tokenMap[tokenId].inverted == false ? 1 : 0;
        try {
            while (patrolData.isWalking && this._validatePatrol(token)) {
                await this._saveAndUpdate(this.tokenMap);
                let result = await this._navigationCycle(cycle, token);
                if (result) return;
                cycle = this.tokenMap[tokenId].inverted == false ? 1 : 0;
            }
            this._disableWalking(token);
        } catch (e) {
            console.log(`Unexpected Error in patrol: Was a token deleted during movement?:\n${e} at ${e.stack}`);
        }
    }

    async stopPatrol(tokenId) {
        this.tokenMap[tokenId].isWalking = false;
        await this._saveAndUpdate(this.tokenMap);
    }

    async _navigationCycle(cycle, token) {
        let patrolData = this.tokenMap[token.id];
        let patrolPoints = patrolData.plots;

        if (patrolData.isLinear && canvas.scene.data.gridType == CONST.GRID_TYPES.SQUARE) {
            if (patrolData.inverted) patrolPoints = patrolData.countinousRoutes;
            else patrolPoints = patrolData.linearPath;
        }

        let forceReturn;
        const settings = {
            // Reduces magic numbers.
            INCREMENT: 1,
            DECREMENT: -1,
            PLOT_SIZE: patrolPoints.length,
            RETURN_SIZE: [].length,
            ON_INVERSE_FALSE: false,
            ON_INVERSE_TRUE: true,
            OPERATOR_GREATER: function (a, b) {
                return a >= b;
            },
            OPERATOR_LESS: function (a, b) {
                return a < b;
            },
        };

        let lastPos = await this._determineLastPosition(cycle, patrolPoints, token);
        forceReturn = await this._navigationLoop(
            patrolPoints,
            lastPos,
            settings.PLOT_SIZE,
            settings.OPERATOR_LESS,
            settings.ON_INVERSE_FALSE,
            settings.INCREMENT,
            token
        );
        if (forceReturn) return;
        lastPos = await this._determineLastPosition(cycle, patrolPoints, token);
        // The -1 indicates that we don't need to revist the last plot, given that we're already there.
        forceReturn = await this._navigationLoop(
            patrolPoints,
            lastPos - 1,
            settings.RETURN_SIZE,
            settings.OPERATOR_GREATER,
            settings.ON_INVERSE_TRUE,
            settings.DECREMENT,
            token
        );
        if (forceReturn) return;
    }

    async _navigationLoop(patrolPoints, iterator, comparison, operation, onReturn, increment, token) {
        let patrolData = this.tokenMap[token.id];
        if (!patrolData) return;
        const sleep = (m) => new Promise((r) => setTimeout(r, m));
        if (patrolData.onInverseReturn == onReturn) {
            for (iterator; operation(iterator, comparison); iterator = iterator + increment) {
                if (!patrolData.isWalking) return true;
                let combatStarted = true;//game.settings.get(TP.MODULENAME, "combatPause");
                /*if (game.settings.get("foundry-patrol", "tokenRotation") || this.tokenMap[token.id].tokenRotation) {
                    //Rotation
                    let dX = patrolPoints[iterator].x - patrolData.lastRecordedLocation.x;
                    let dY = patrolPoints[iterator].y - patrolData.lastRecordedLocation.y;
                    this.rotateToken(dX, dY, token);
                }*/

                if (patrolData.delayPeriod.length == patrolPoints.length) {
                    await sleep(patrolData.delayPeriod[iterator]);
                } else await sleep(patrolData.delayPeriod[Math.floor(Math.random() * patrolData.delayPeriod.length)]); // Randomly selects a value within the delay period.
                if (!this.tokenMap[token.id]) return;

                if (
                    patrolData.isWalking &&
                    !game.paused &&
                    (!combatStarted || !(combatStarted && getProperty(game.combats.active, "started"))) &&
                    !this._wasTokenMoved(token) &&
                    this._validatePatrol(token) &&
                    !patrolData.isDeleted
                ) {
                    await this._navigateToNextPoint(patrolPoints[iterator], token);
                    await this._ensureAnimationCompletion(token);
                    //await TP.speechHandler.handleSpeech(token.id, "patrol");
                   // await TP.visionHandler.evaluateSight(token.id);
                    this._storeLastPlotTaken(iterator, token);
                    if (false) {
                        // Future update, maybe
                        await this.sayMessage(token);
                    }
                } else {
                    if (game.paused == true || combatStarted == true) {
                        iterator = iterator - increment;
                    } else {
                        return true;
                    }
                }
            }
            if (patrolData.onInverseReturn || patrolData.inverted) {
                this._setInverseReturn(token);
            }
        }
    }

    async _ensureAnimationCompletion(token) {
        return new Promise(function (resolve, reject) {
            (function waitForAnimation() {
                if (!CanvasAnimation.animations[`Token.${token.id}.animateMovement`]) return resolve();
                setTimeout(waitForAnimation, 30);
            })();
        });
    }

    async _determineLastPosition(cycle, plots, token) {
        let patrolData = this.tokenMap[token.id];
        let lastPos = patrolData.lastPos;
        if (!patrolData.isInverted) {
            if (cycle != 0 && lastPos == plots.length - 1) {
                return 0;
            }
            return lastPos;
        } else {
            return lastPos;
        }
    }

    async _navigateToNextPoint(plot, token) {
        try {
           /* if (this._hasAudio(token.id)) {
                await TP.audioHandler.updateAmbientPosition(plot.x, plot.y, this.tokenMap[token.id].audioId);
            }*/

            await token.update(plot);

            this._updatelastRecordedLocation(plot, token);
        } catch (error) {
            if (this.debug) console.log(`Foundry-Patrol: Error in token navigation\n${error}`);
        }
    }

    async _handleDelayPeriod(delay, tokenId) {
        const MILLISECONDS = 1000;
        const DEFAULT_SECONDS = 2;
        const INVALID_NUMBER = 0;
        if (delay == null) {
            return;
        } else {
            if (delay.match(/[^0-9&^\-&^\[&^\]&^\,&^\s]/g)) return;

            delay = this._processDelayRegex(delay);
        }
        try {
            for (let i = 0; i < delay.length; ++i) {
                if (delay[i] <= INVALID_NUMBER) delay[i] = delay[i] * -1 + DEFAULT_SECONDS;
                delay[i] = delay[i] * MILLISECONDS;
            }
            this.tokenMap[tokenId].delayPeriod = delay;
        } catch (error) {
            // Occurs in the event the user fails to properly pass values. Simply returning will use the previously stored delayPeriod.
            return;
        }
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
        return this.tokenMap[tokenId].delayPeriod;
    }

    /**
     * Parses the string to generate a valid array of ints.
     * Excess commas are ignored
     * Acceptable: [1-5] --> 1,2,3,4,5
     * Acceptable: 1,2,3,4,5 --> 1,2,3,4,5
     * Acceptable: [1-5],6,7 --> 1,2,3,4,5,6,7
     * @param {string} delay
     */
    _processDelayRegex(delay) {
        delay = delay.replace(/ /g, ""); // Remove Space
        let singleValue = delay.match(/[0-9]+/g);
        delay += ","; // This is a cheap work around for the regex. Since lookbehinds don't work in most browsers.
        let commaSeperated = delay.match(/(\d+(?=,))/g); // Checks for values that are strictly digits followed by commas.
        let rangeDelay = delay.match(/(\d+\-\d+)/g);
        delay = [];
        if (singleValue.length == 1) {
            // In the case there is only one value.
            delay.push(parseInt(singleValue[0]));
            return delay;
        }
        if (rangeDelay) {
            // In the case there is a [x1-x2] range.
            rangeDelay.forEach(function (rangeSet) {
                let rangeValues = rangeSet.split("-");
                for (let i = parseInt(rangeValues[0]); i <= parseInt(rangeValues[1]); i++) {
                    delay[delay.length] = i;
                }
            });
        }

        if (commaSeperated) {
            // In the case there is a x1,x2,.....,xn csv.
            commaSeperated.forEach(function (csvValue) {
                delay[delay.length] = parseInt(csvValue);
            });
        }
        if (this.debug) console.log(`Foundry-Patrol: Wait periods include: ${delay}`);
        return delay;
    }

    rotateToken(dX, dY, token) {
        //token.rotate(DEGREES)
        if (dX < 0 && dY > 0) token.update({ rotation: 45 });
        else if (dX < 0 && dY == 0) token.update({ rotation: 90 });
        else if (dX < 0 && dY < 0) token.update({ rotation: 135 });
        else if (dX == 0 && dY < 0) token.update({ rotation: 180 });
        else if (dX > 0 && dY < 0) token.update({ rotation: 225 });
        else if (dX > 0 && dY == 0) token.update({ rotation: 270 });
        else if (dX > 0 && dY > 0) token.update({ rotation: 315 });
        else if (dX == 0 && dY > 0) token.update({ rotation: 0 });
        else if (dX != 0 && dY != 0)
            if (this.debug)
                //token.rotate(0);
                console.log("Unexpected direction");
    }

    async linearWalk(generateEnd, tokenId) {
        if (canvas.scene.data.gridType != CONST.GRID_TYPES.SQUARE) return;

        let plot = JSON.parse(JSON.stringify(this._getPlotsFromId(tokenId)));

        if (!plot) return;

        let len = plot.length - 1;
        if (generateEnd) {
            const ROUTE_START = 0;
            let xMod = plot[ROUTE_START].x >= plot[len].x ? 1 : -1;
            let yMod = plot[ROUTE_START].y >= plot[len].y ? 1 : -1;
            this._getGeneral(tokenId, "endCountinousRoutes").length = 0;
            if (await this._generateLinearRoute(this._getGeneral(tokenId, "endCountinousRoutes"), plot[len], plot[ROUTE_START], xMod, yMod))
                this._generateLinearPath(tokenId);
        } else if (plot.length < 2) {
            this._getGeneral(tokenId, "countinousRoutes").push(plot[0]);
            await TP.tokenPatroller._saveAndUpdate(this.tokenMap);
        } else {
            let xMod = plot[len].x >= plot[len - 1].x ? 1 : -1;
            let yMod = plot[len].y >= plot[len - 1].y ? 1 : -1;
            await this._generateLinearRoute(this._getGeneral(tokenId, "countinousRoutes"), plot[len - 1], plot[len], xMod, yMod);
        }
    }

    // [1------5]
    // [1 = 5]
    // [1,2,]
    // [1,2,3,4,5]

    async _generateLinearRoute(route, src, dest, xMod, yMod) {
        const GRID_SIZE = canvas.grid.size;

        if (src.x % GRID_SIZE != 0 && src.y % GRID_SIZE != 0 && dest.x % GRID_SIZE != 0 && dest.y % GRID_SIZE != 0) {
            ui.notifications.error("Can't process linear walk of the given coordinates. Please send console output to @JacobMcAuley on discord");
            console.log(route);
            console.log(src);
            console.log(dest);
            console.log(`XMOD: ${xMod}`);
            console.log(`YMOD: ${yMod}`);
            return false;
        }
        if (src.x == dest.x && src.y == dest.y) {
            await TP.tokenPatroller._saveAndUpdate(this.tokenMap);
            return true;
        } else if (src.x != dest.x && src.y != dest.y) {
            //<-- Bad one 100,100 -> 102, 100
            src.x += GRID_SIZE * xMod;
            src.y += GRID_SIZE * yMod;
            route.push({ x: src.x, y: src.y });
            return await this._generateLinearRoute(route, src, dest, xMod, yMod);
        } else if (src.x == dest.x && src.y != dest.y) {
            //<-- Bad one
            src.y += GRID_SIZE * yMod;
            route.push({ x: src.x, y: src.y });
            return await this._generateLinearRoute(route, src, dest, xMod, yMod);
        } else if (src.x != dest.x && src.y == dest.y) {
            //<-- Bad one
            src.x += GRID_SIZE * xMod;
            route.push({ x: src.x, y: src.y });
            return await this._generateLinearRoute(route, src, dest, xMod, yMod);
        } else {
            if (this.debug) console.log("Foundry-Patrol: Error in generating Continuous route.");
        }
    }

    _generateLinearPath(tokenId) {
        const result = [];
        let contRoutes = this.tokenMap[tokenId].countinousRoutes;
        let endRoutes = this.tokenMap[tokenId].endCountinousRoutes;

        Object.keys(contRoutes).forEach((key) => result.push(contRoutes[key]));

        Object.keys(endRoutes).forEach((key) => result.push(endRoutes[key]));

        this.tokenMap[tokenId].linearPath = result;
    }

    updateTokenRoute(tokenId, updateData) {
        if (this.tokenMap[tokenId]) {
            this.tokenMap[tokenId]["plots"].push(updateData);
        } else {
            let generatedColor = this._generateColor();
            this.tokenMap[tokenId] = {};
            this.tokenMap[tokenId] = {
                color: generatedColor,
                plots: [],
                linearPath: [],
                countinousRoutes: [],
                endCountinousRoutes: [],
                enabled: false,
                lastPos: 0,
                onInverseReturn: false,
                drawnPlots: [],
                isWalking: false,
                inverted: false,
                isLinear: false,
                lastRecordedLocation: {},
                delayPeriod: [2000],
                isDeleted: false,
                audioId: null,
                audioLocal: true,
                audioPath: null,
                audioVolume: null,
                audioRadius: null,
                tokenRotation: false,
                visionChecking: false,
                stopWhenSeen: false,
                createCombat: false,
                pauseGame: false,
                enableQuotes: false,
                patrolPercent: 25,
                patrolQuotes: [],
                catchQuotes: [],
                otherTokenVision: false,
                otherTokenVisionQuotes: [],
                language: "common",
            };
            this.tokenMap[tokenId]["plots"].push(updateData);
        }
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    generateTokenSchema(tokenId) {
        let generatedColor = this._generateColor();
        this.tokenMap[tokenId] = {
            color: generatedColor,
            plots: [],
            linearPath: [],
            countinousRoutes: [],
            endCountinousRoutes: [],
            enabled: false,
            lastPos: 0,
            onInverseReturn: false,
            drawnPlots: [],
            isWalking: false,
            inverted: false,
            isLinear: false,
            lastRecordedLocation: {},
            delayPeriod: [2000],
            isDeleted: false,
            tokenRotation: false,
            audioId: null,
            audioLocal: true,
            audioPath: null,
            audioVolume: null,
            audioRadius: null,
            visionChecking: false,
            stopWhenSeen: false,
            createCombat: false,
            pauseGame: false,
            enableQuotes: false,
            patrolPercent: 25,
            patrolQuotes: [],
            catchQuotes: [],
            otherTokenVision: false,
            otherTokenVisionQuotes: [],
            language: "common",
        };
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
        return this.tokenMap[tokenId];
    }

    async removeTokenRoute(tokenId, removeAll = false) {
        if (!this.tokenMap[tokenId]) return;

        this.tokenMap[tokenId].linearPath = [];

        if (removeAll) {
            this.tokenMap[tokenId].plots = [];
            this.tokenMap[tokenId].countinousRoutes = [];
            this.tokenMap[tokenId].endCountinousRoutes = [];
            this.tokenMap[tokenId].lastRecordedLocation = {};
            this.tokenMap[tokenId].lastPos = 0;
        } else {
            let len = this.tokenMap[tokenId]["plots"].length;
            let p1 = this.tokenMap[tokenId]["plots"][len - 1];
            let p2 = this.tokenMap[tokenId]["plots"][len - 2];
            this.tokenMap[tokenId]["plots"].pop();
            this.tokenMap[tokenId].lastPos = 0;
            this.tokenMap[tokenId]["countinousRoutes"].length -= this._adjustLength(p1, p2);
            await this.linearWalk(false, tokenId);
            await this.linearWalk(true, tokenId);
        }
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
        this.livePlotUpdate(tokenId);
    }

    _adjustLength(p1, p2) {
        return Math.floor(Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)) / canvas.grid.size);
    }

    removeAllTokenRoutes() {
        TP.tokenPatroller._saveAndUpdate({});
        this.livePlotUpdate(null);
    }

    _generateColor() {
        const HEX_LENGTH = 6;
        let options = "0123456789ABCDEF";
        let color = "0x";

        for (let i = 0; i < HEX_LENGTH; ++i) {
            color += options[Math.floor(Math.random() * options.length)];
        }
        return color;
    }

    deleteProcess(tokenId) {
        let deletePrompt = new Dialog({
            title: "Patrol Delete",
            buttons: {
                one: {
                    icon: '<i class="fas fa-check"></i>',
                    label: "Confirm: Yes, delete all",
                    callback: () => this.removeTokenRoute(tokenId, true),
                },
                two: {
                    icon: '<i class="fas fa-undo"></i>',
                    label: "Undo: Yes, but undo last",
                    callback: () => this.removeTokenRoute(tokenId, false),
                },
                three: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Reject: I do not want to delete",
                    callback: () => console.log("Foundry-Patrol: Mind changed, nothing deleted"),
                },
            },
            default: "Ack",
            close: () => console.log("Foundry-Patrol: Prompt Closed"),
        });
        deletePrompt.render(true);
    }

    deleteToken(tokenId) {
        if (!this.tokenMap[tokenId]) return;

        let audioId = this.tokenMap[tokenId].audioId;
        if (audioId) canvas.sounds.placeables.filter((entry) => entry.id == audioId)[0].delete();

        delete this.tokenMap[tokenId];
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    deleteAmbientSound(tokenId) {
        if (!tokenId || !this.tokenMap[tokenId]) return;

        this.tokenMap[tokenId].audioId = null;
        this.tokenMap[tokenId].audioPath = null;
        this.tokenMap[tokenId].audioVolume = null;
        this.tokenMap[tokenId].audioRadius = null;

        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    livePlotUpdate(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        this._removePlotDrawing(tokenId);
        canvas.layers[this.GLOBAL_ROUTES_INDEX].deactivate();
        this._displayPlot(tokenId, this.tokenMap[tokenId].inverted);
        canvas.layers[this.GLOBAL_ROUTES_INDEX].draw();
    }

    _removePlotDrawing(tokenId) {
        let flags = canvas.scene.data.flags;
        let plotIndex = flags.routes.findIndex(function (element) {
            return element.tokenId == tokenId;
        });
        if (plotIndex != -1) {
            flags.routes.splice(plotIndex, 1);
            canvas.scene.update({ flags: flags });
        }
    }

    async _displayPlot(tokenId, forwardsBackwards) {
        let flags = canvas.scene.data.flags;
        let plots = this._getPlotsFromId(tokenId);
        if (!flags || !plots) return;

        if (plots.length > 0) {
            let tokenColor = null; //this._getGeneral(tokenId, 'color');
            let drawnPlot = new drawRoute({
                points: plots,
                dash: 25,
                gap: 25,
                offset: 750,
                color: this._getGeneral(tokenId, "color"),
                fb: forwardsBackwards,
                tokenId: tokenId,
            });
            flags.routes.push(drawnPlot);
            canvas.scene.update({ flags: flags });
        }
    }

    _getPlotsFromId(tokenId) {
        return getProperty(this.tokenMap, tokenId + ".plots");
    }

    _getDrawnPlot(tokenId) {
        return getProperty(this.tokenMap, tokenId + ".drawnPlots") || false;
    }

    _getGeneral(tokenId, desiredProperty) {
        return getProperty(this.tokenMap, tokenId + "." + desiredProperty);
    }

    _validatePatrol(token) {
        let patrolPoints = this._getPlotsFromId(token.id);
        if (!patrolPoints || patrolPoints.length <= 1) {
            return false;
        }
        return true;
    }

    _storeLastPlotTaken(plotNumber, token) {
        this.tokenMap[token.id].lastPos = plotNumber;
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    _updatelastRecordedLocation(futurePlot, token) {
        let lastRecordedLocation = this.tokenMap[token.id].lastRecordedLocation;
        if (futurePlot != undefined) {
            lastRecordedLocation.x = futurePlot.x;
            lastRecordedLocation.y = futurePlot.y;
        } else {
            lastRecordedLocation.x = getProperty(token.data, "x");
            lastRecordedLocation.y = getProperty(token.data, "y");
        }
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    _wasTokenMoved(token) {
        try {
            if (
                this.tokenMap[token.id].lastRecordedLocation.x != getProperty(token.data, "x") ||
                this.tokenMap[token.id].lastRecordedLocation.y != getProperty(token.data, "y")
            ) {
                this.tokenMap[token.id].isWalking = false;
                return true;
            }
            return false;
        } catch (error) {
            if (this.debug) console.log(`Foundry-patrol: Error in validating patrol status -> \n ${error}`);
            return true;
        }
    }

    _setLinear(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        this.tokenMap[tokenId].isLinear = !this.tokenMap[tokenId].isLinear;
        this.tokenMap[tokenId].lastPos = 0;
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    _setInverse(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        this.tokenMap[tokenId].inverted = !this.tokenMap[tokenId].inverted;
        this.tokenMap[tokenId].lastPos = 0;
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
        this.livePlotUpdate(tokenId);
    }

    _setInverseReturn(token) {
        if (!this.tokenMap[token.id]) return;
        this.tokenMap[token.id].onInverseReturn = !this.tokenMap[token.id].onInverseReturn;
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    _disableWalking(token) {
        if (!this.tokenMap[token.id]) return;
        this.tokenMap[token.id].isWalking = false;
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    async getDelayPeriod(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        let patrolData = this.tokenMap[tokenId];
        let userDisplayDelay = []; // a more visually friendly format.
        for (let i = 0; i < patrolData.delayPeriod.length; ++i) {
            userDisplayDelay.push(patrolData.delayPeriod[i] / 1000);
        }
        return userDisplayDelay;
    }

    //Line 17884 Foundry.js
    _getDuration(message) {
        let words = message.split(" ").map((w) => w.trim()).length;
        let ms = (words * 60 * 1000) / 300;
        return Math.clamped(1000, ms, 20000);
    }

    addPatrolMessage(tokenId, message) {
        if (!this.tokenMap[tokenId]) TP.tokenPatroller.generateTokenSchema(tokenId);

        this.tokenMap[tokenId].patrolMessages.push(message);
        TP.tokenPatroller._saveAndUpdate(this.tokenMap);
    }

    getLanguage(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].language;
    }

    getAudioPath(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].audioPath;
    }

    getPatrolPercent(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].patrolPercent;
    }

    getAudioLocal(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].audioPath;
    }

    getAudioVolume(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].audioVolume;
    }

    getAudioRadius(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].audioRadius;
    }

    getAudioID(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].audioId;
    }

    getEnableQuotes(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].enableQuotes;
    }

    getVisionChecking(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].visionChecking;
    }

    getOtherVisionChecking(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].otherTokenVision;
    }

    getStopWhenSeen(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].stopWhenSeen;
    }

    getCreateCombat(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].createCombat;
    }

    getPauseGame(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].pauseGame;
    }

    getPatrolQuotes(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].patrolQuotes;
    }

    getCatchQuotes(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].catchQuotes;
    }

    getOtherTokenVisionQuotes(tokenId) {
        if (!this.tokenMap[tokenId]) return;
        return this.tokenMap[tokenId].otherTokenVisionQuotes;
    }

    getTokenData(tokenId) {
        if (this.tokenMap[tokenId]) return this.tokenMap[tokenId];
        return this.generateTokenSchema(tokenId);
    }

    updateFormRelatedData(formData, tokenId) {
        for (const key in formData) {
            if (key == "isLinear" && formData[key] != this.tokenMap[tokenId].isLinear) this._setLinear(tokenId);
            else if (key == "inverted" && formData[key] != this.tokenMap[tokenId].inverted) this._setInverse(tokenId);
            else this.tokenMap[tokenId][key] = formData[key];
        }
        this._saveAndUpdate(this.tokenMap);
        this._releaseToken(tokenId);
    }

    _releaseToken(tokenId) {
        canvas.tokens.get(tokenId).release();
    }

    _hasAudio(tokenId) {
        return this.tokenMap[tokenId].audioId != null;
    }
}

class TokenHud {
    constructor() {}

    static async HUD(token, html, data) {
        let tokenId = getProperty(token, "data._id");
       // let tokenMap = await TP.patrolDataManager.getMap();
        let patrolData = false;//getProperty(tokenMap, tokenId);
        let isPatrolling = false;
        let isLinear = false;
        let isInverted = false;
        let delayPeriod = 2;
        if (patrolData) {
            isPatrolling = patrolData.isWalking;
            isLinear = patrolData.isLinear;
            isInverted = patrolData.inverted;
            delayPeriod = await TP.tokenPatroller.getDelayPeriod(tokenId);
        }

        const plotDiv = $(`
            <div class="plotDiv" style="display: flex; flex-direction: row; justify-content: center; align-items:center; margin-right: 75px;">\
            </div>
        `);

        const addPlotPoint = $(`
            <div class="control-icon" style="margin-left: 4px;"> \ 
                <img src="modules/foundry-patrol/imgs/svg/map.svg" width="36" height="36" title="Add Point"> \
            </div>
        `);

        const deletePlotPoint = $(`<i class="control-icon fas fa-trash-alt" style="margin-left: 4px;" title="Delete Point"></i>`);

        const patrolMenu = $(`<i class="control-icon fas fa-caret-down" style="margin-left: 4px;" title="Patrol Menu"></i>`);

        let plotDirection = $(`<i class="control-icon fas fa-recycle" style="margin-left: 4px;" title="Cycle Mode"></i>`);

        if (isInverted) {
            plotDirection = $(`<i class="control-icon fas fa-arrows-alt-h" style="margin-left: 4px;" title="Forwards-Backwards Mode"></i>`);
        }

        const patrolDiv = $(`
            <div class="patrolDiv" style="display: flex; flex-direction: row; justify-content: center; align-items:center; margin-right: 75px;">\
            </div>
        `);

        let linearWalkHUD = $(`
            <div class="control-icon" style="margin-left: 4px;"> \ 
                <img id="linearHUD" src="modules/foundry-patrol/imgs/svg/line.svg" width="36" height="36" title="Linear Walk"> \
            </div>
        `);

        if (isLinear) {
            linearWalkHUD = $(`
                <div class="lineWalk control-icon" style="margin-left: 4px;"> \ 
                    <img id="linearHUD" src="modules/foundry-patrol/imgs/svg/linear.svg" width="36" height="36" title="Plot Walk"> \
                </div>
            `);
        }

        let patrolWalkHUD = $(`<i class="fas fa-walking title control-icon" style="margin-left: 4px;" title="Start route"></i>`);

        if (isPatrolling) {
            patrolWalkHUD = $(`<i class="fas fa-times title control-icon" style="margin-left: 4px;" title="Stop route"></i>`);
        }
        // value =
        const patrolDelayHUD = $(
            `<input class="control-icon"  style="margin-left: 4px;" type="text" id="patrolWait" value=${delayPeriod} name="patrolWait" title="Delay period">`
        );

        if (game.user.isGM || game.settings.get("foundry-patrol", "enablePlayerPatrol")) {

                html.find(".left").append(plotDiv);
                html.find(".plotDiv").append(addPlotPoint);
                html.find(".plotDiv").append(deletePlotPoint);
                html.find(".plotDiv").append(plotDirection);
                html.find(".left").append(patrolDiv);
                html.find(".patrolDiv").append(linearWalkHUD);
                html.find(".patrolDiv").append(patrolWalkHUD);
                html.find(".patrolDiv").append(patrolDelayHUD);
            

            html.find(".right").append(patrolMenu);

            addPlotPoint.click((ev) => {
                TP.tokenPatroller.addPlotPoint(tokenId);
            });

            deletePlotPoint.click((ev) => {
                TP.tokenPatroller.deleteProcess(tokenId);
            });

            linearWalkHUD.click((ev) => {
              /*  let src = ev.target.getAttribute("src");

                if (canvas.scene.data.gridType != CONST.GRID_TYPES.SQUARE) {
                    ui.notifications.error("Linear path can only be used on square based maps.");
                    return;
                }
                if (src == "modules/foundry-patrol/imgs/svg/linear.svg") {
                    ev.target.setAttribute("src", "modules/foundry-patrol/imgs/svg/line.svg");
                } else {
                    ev.target.setAttribute("src", "modules/foundry-patrol/imgs/svg/linear.svg");
                }
                if (patrolData) TP.tokenPatroller._setLinear(tokenId);*/
            });

            plotDirection.click((ev) => {
                /*let className = ev.target.getAttribute("class");
                if (className == "control-icon fas fa-arrows-alt-h") {
                    ev.target.className = "control-icon fas fa-recycle";
                } else {
                    ev.target.className = "control-icon fas fa-arrows-alt-h";
                }
                if (patrolData) TP.tokenPatroller._setInverse(tokenId);*/
            });

            patrolWalkHUD.click((ev) => {
               /* let className = ev.target.getAttribute("class");
                if (className == "fas fa-walking title control-icon") {
                    ev.target.className = "fas fa-times title control-icon";
                    let delayPeriod = document.getElementById("patrolWait").value;
                    if (patrolData) TP.tokenPatroller.startPatrol(delayPeriod, tokenId);
                } else {
                    ev.target.className = "fas fa-walking title control-icon";
                    TP.tokenPatroller.stopPatrol(tokenId);
                }*/
            });

            patrolMenu.click((ev) => {
                new PatrolMenu(tokenId).render(true);
            });
        }
    }
}

class PatrolMenu extends FormApplication {
    constructor(tokenId, ...args) {
        super(...args);
        this.tokenId = tokenId;
        this.language = null;
        this.processedData = {};
    }

    static get defaultOptions() {
        const options = super.defaultOptions;
        options.template = "worlds/candlekeep-mysteries-test/scripts/patrol_menu.html";
        options.width = 600;
        options.height = "auto";
        options.title = "Patrol Menu Options";
        options.closeOnSubmit = true;
        options.id = "patrol-container";
        return options;
    }

    async getData() {
        let tokenData = TP.tokenPatroller.getTokenData(this.tokenId);
        const templateData = {
            tokenId: this.tokenId,
            polygot: game.modules.has("polyglot") ? game.modules.get("polyglot").active : false,
            lang:
                game.modules.has("polyglot") && game.modules.get("polyglot").active
                    ? (() => {
                          let actors = [];
                          let known_languages = new Set();
                          for (let token of [canvas.tokens.get(this.tokenId)]) {
                              if (token.actor) actors.push(token.actor);
                          }
                          if (actors.length == 0 && game.user.character) actors.push(game.user.character);
                          for (let actor of actors) {
                              try {
                                  // Don't duplicate the value in case it's a not an array
                                  for (let lang of actor.data.data.traits.languages.value) known_languages.add(lang);
                              } catch (err) {
                                  // Maybe not dnd5e, pf1 or pf2e or corrupted actor data?
                              }
                          }
                          if (known_languages.size == 0) {
                              if (game.user.isGM) known_languages = new Set(Object.keys(PolyGlot.languages));
                              else known_languages.add("common");
                          }
                          return known_languages;
                      })()
                    : "common",
            audioPath: tokenData.audioPath,
            audioLocal: tokenData.audioLocal,
            audioRadius: tokenData.audioRadius,
            audioVolume: tokenData.audioVolume,
            catchQuotes: this._quoteHelper(tokenData.catchQuotes), // Special
            createCombat: tokenData.createCombat,
            pauseGame: tokenData.pauseGame,
            delayPeriod: this._delayHelper(tokenData.delayPeriod), // Special
            inverted: tokenData.inverted,
            isLinear: tokenData.isLinear,
            tokenRotation: tokenData.tokenRotation,
            otherTokenVision: tokenData.otherTokenVision,
            otherTokenVisionQuotes: this._quoteHelper(tokenData.otherTokenVisionQuotes), // Special
            enableQuotes: tokenData.enableQuotes,
            patrolPercent: tokenData.patrolPercent,
            patrolQuotes: this._quoteHelper(tokenData.patrolQuotes), // Special
            stopWhenSeen: tokenData.stopWhenSeen,
            visionChecking: tokenData.visionChecking,
        };
        return templateData;
    }

    _delayHelper(delayPeriod) {
        if (delayPeriod.length <= 0) return null;
        let string = '"';
        delayPeriod.forEach((delay) => {
            string = string + delay / 1000 + ",";
        });
        return string.slice(0, -1) + '"';
    }

    _quoteHelper(quotes) {
        if (!quotes || quotes.length <= 0) return null;
        let string = "";
        quotes.forEach((quote) => {
            string = string + "'" + quote + "'" + " ";
        });
        return string;
    }

    async _updateObject(event, formData) {
        //Handle Form Data
        formData.language = this.language;

        this._handleDelete(formData);
        await this._processHUDSettings(formData);
        console.log(formData["polyglot-language"]);
        this._handleQuoteData(formData);
        await this._handleAudioData(formData);
        TP.tokenPatroller.updateFormRelatedData(formData, this.tokenId);
        return;
    }

    async _processHUDSettings(formData) {
        if (formData.isLinear && canvas.scene.data.gridType != CONST.GRID_TYPES.SQUARE) {
            formData.isLinear = false;
            ui.notifications.error("Linear path can only be used on square based maps, linear mode was disabled for you.");
        }

        let delay = formData.delayPeriod.match(/"([^"]*)"/g).map((entry) => entry.slice(1, -1));
        if (!delay) {
            console.log("Error");
            return [2000];
        }
        formData.delayPeriod = await TP.tokenPatroller._handleDelayPeriod(delay[0], this.tokenId);
    }

    _handleDelete(formData) {
        if (formData.delete) TP.tokenPatroller.removeTokenRoute(this.tokenId, true);
        delete formData.delete;
    }

    _handleQuoteData(formData) {
        let patrolQuotes =
            formData.patrolQuotes.length <= 0 ? null : (formData.patrolQuotes.match(/'([^']*)'/g) || []).map((entry) => entry.slice(1, -1));
        let catchQuotes =
            formData.catchQuotes.length <= 0 ? null : (formData.catchQuotes.match(/'([^']*)'/g) || []).map((entry) => entry.slice(1, -1));
        let otherTokenVisionQuotes =
            formData.otherTokenVisionQuotes.length <= 0
                ? null
                : (formData.otherTokenVisionQuotes.match(/'([^']*)'/g) || []).map((entry) => entry.slice(1, -1));
        formData.patrolQuotes = patrolQuotes;
        formData.catchQuotes = catchQuotes;
        formData.otherTokenVisionQuotes = otherTokenVisionQuotes;
    }

    async _handleAudioData(formData) {
        const audioPath = formData.audioPath;
        const audioRadius = formData.audioRadius;
        const audioVolume = formData.audioVolume;
        const audioLocal = formData.audioLocal;

        if (
            TP.audioHandler.hasAudio(this.tokenId) &&
            (audioPath != TP.tokenPatroller.getAudioPath(this.tokenId) ||
                audioRadius != TP.tokenPatroller.getAudioRadius(this.tokenId) ||
                audioVolume != TP.tokenPatroller.getAudioVolume(this.tokenId) ||
                audioLocal != TP.tokenPatroller.getAudioLocal(this.tokenId))
        ) {
            TP.audioHandler.updateAudioInfo(TP.tokenPatroller.getAudioID(this.tokenId), audioPath, audioLocal, audioRadius, audioVolume);
            return;
        } else if (TP.audioHandler.hasAudio(this.tokenId) || audioPath.length == 0 || !formData.audioRadius || !formData.audioVolume) return;

        //

        formData["audioId"] = (
            await TP.audioHandler.createPatrolAudio(this.tokenId, formData.audioPath, audioLocal, formData.audioRadius, formData.audioVolume)
        ).id;

        formData.audioPath;
        formData.audioRadius;
        formData.audioVolume;
    }

    activateListeners(html) {
        const body = $("#patrol-container");
        const settings = $("#patrol-settings");
        const settingsButton = $(".settings-button");
        const quotes = $("#quotes");
        const quotesButton = $(".quotes-button");
        const vision = $("#vision");
        const visionButton = $(".vision-button");
        const audio = $("#audio");
        const audioButton = $(".audio-button");

        let currentTab = settingsButton;
        let currentBody = settings;
        super.activateListeners(html);

        $("#polyglot-patrol").click((x, y, z) => {
            let selectedLang = $("#polyglot-patrol option:selected").text();
            if (!selectedLang) return;
            this.language = selectedLang;
        });

        $(".nav-tab").click(function () {
            currentBody.toggleClass("hide");
            currentTab.toggleClass("selected");
            if ($(this).hasClass("settings-button")) {
                settings.toggleClass("hide");
                currentBody = settings;
                currentTab = settingsButton;
            } else if ($(this).hasClass("quotes-button")) {
                quotes.toggleClass("hide");
                currentBody = quotes;
                currentTab = quotesButton;
            } else if ($(this).hasClass("vision-button")) {
                vision.toggleClass("hide");
                currentBody = vision;
                currentTab = visionButton;
            } else if ($(this).hasClass("audio-button")) {
                audio.toggleClass("hide");
                currentBody = audio;
                currentTab = audioButton;
            }
            currentTab.toggleClass("selected");
            body.height("auto");
        });
    }

    /**
     * Taken from Foundry.js line 18579
     */
    _onSourceChange(event) {
        event.preventDefault();
        const field = event.target;
        const form = field.form;
        if (!form.name.value) form.name.value = field.value.split("/").pop().split(".").shift();
    }
}
TokenPatrollerInitalizer.initialize();