let config = module.exports = {};

config.priceApiKey = undefined;

config.env = process.env.NODE_ENV;

// Debug turns on non-key trades BUT DOES NOT stop trades or messages
config.DEBUG = true;

// Maintenance allows manually setting overrideTx, stops messages and trades
config.maintenance = true;

config.logLevel = "verbose";

config.steam = {
    sharedSecret: "",
    identitySecret: "",
    username: "",
    password: "",
    groupid: "",
    acceptNewInvites: true,
}

config.keys = {
    buyingPrice: "10.00",
    sellingPrice: "0.1",
    allowedKeys: [
        "Clutch Case Key", 
        "Spectrum 2 Case Key",  
        "Spectrum Case Key", 
        "Glove Case Key", 
        "Gamma 2 Case Key", 
        "Gamma Case Key", 
        "Chroma 3 Case Key", 
        "Operation Wildfire Case Key",   
        "Shadow Case Key",  
        "Operation Phoenix Case Key",  
        "Operation Breakout Case Key",  
        "Huntsman Case Key", 
        "Falchion Case Key", 
        "CS:GO Case Key",  
        "Chroma Case Key", 
        "Chroma 2 Case Key",
        "Horizon Case Key",
        "Winter Offensive Case Key",
        "Operation Vanguard Case Key",
    ]
}

config.monero = {
    onMainNet: false,
    testNetPort: 28083,
    mainNetPort: 18083,
    minBlockHeight: 1135276,
    transactionPoll: 10,
    overrideTx: undefined,
}

config.sql = {
    username: "",
    password: "",
    database: "",
    customerTable: "",
    depositTable: "",
    withdrawTable: "",
}

config.email = {
    username: "",
    pass: "",
}

config.admins = [
    "76561197972856152", // sham
]

config.banned = [
    
]