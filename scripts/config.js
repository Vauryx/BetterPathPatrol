const TP = this.TP || {};

TP.MODULENAME = "better-path-patrol";

TP["PATROLCONFIG"] = [
    {
        key: "drawnRoutes",
        settings: {
            scope: "world",
            default: [],
            type: Object,
        },
    },
    {
        key: "combatPause",
        settings: {
            name: "Pause path patrols on combat start",
            hint: "When an encounter is started via begin Combat, patrols will stop.",
            type: Boolean,
            default: false,
            scope: "client",
            config: true,
        },
    }
];