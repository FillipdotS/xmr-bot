// Config
const config = require('./config');

// General libraries
const mysql = require('mysql');
const request = require('request');
const RpcClient = require('node-json-rpc2').Client;
const storage = require('node-persist');
const logger = require('./logger.js');
//const sleep = require('sleep');

// Specific steam libraries
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

// DO NOT RUN BOT WITH config.DEBUG = true
// IT WILL ALLOW NON-KEY TRADES
logger.warn(config.env.toUpperCase() + " config");
logger.warn("DEBUG is " + config.DEBUG + " | MAINTENANCE is " + config.maintenance);

// For manual login
//logger.info(SteamTotp.generateAuthCode());
//

if (config.DEBUG && !config.maintenance && config.env !== "development") {
  logger.error("Are you REALLY sure you want to run DEBUG = true with maintenance = false while not in a development enviroment? Sleeping for a few seconds.");

  //sleep.sleep(5);
}

if (config.sql.database.substring(0, 2) == "tn_" && config.onMainNet) {
  logger.warn("Testnet database being used on the main net.");
}

//
// Steam setup
//

// Array of steam64 ids
const bannedUsers = config.banned;
logger.verbose("Loaded " + bannedUsers.length + " banned users");

const logOnOptions = {
  accountName: config.steam.username,
  password: config.steam.password,
  twoFactorCode: SteamTotp.generateAuthCode(config.steam.sharedSecret),
};

const client = new SteamUser();
const community = new SteamCommunity();
const manager = new TradeOfferManager({
  steam: client,
  community: community,
  language: 'en',
});

const secondsBetweenUpdate = 600; // price update

let keyPriceBuying = config.keys.buyingPrice; // The bot buys keys for this price
let keyPriceSelling = config.keys.sellingPrice; // Bot sells keys for this price
if (keyPriceBuying === 0 || keyPriceSelling === 0) {
  logger.error("Key prices equal zero, aborting");
  throw "Key prices equal zero.";
}

let currentXMRPrice = 0;

//
// Storage / node-persist setup
//

let lastIncomingTx = undefined;
// The name of the variable in storage | MAINNET is not defined by this point
const lastIncomingTx_name = config.monero.onMainNet ? "lastIncomingTx" : "tn_lastIncomingTx";

storageConfig = {
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: "utf8",
};

async function storageSetup() {
  await storage.init(storageConfig);

  // Override current lastIncomingTx value
  // Keep this undefined to prevent override
  let overrideTx = config.monero.overrideTx;

  if (overrideTx != undefined) {
    if (!config.maintenance) {
      logger.error("Attempted to manually set lastIncomingTx when not in maintenance mode.");
      process.exit(1);
    }
    await storage.setItem(lastIncomingTx_name, overrideTx);
  }

  lastIncomingTx = await storage.getItem(lastIncomingTx_name);

  if (lastIncomingTx == undefined) {
    return Promise.reject("lastIncomingTx is undefined");
  }

  logger.info("lastIncomingTx is " + lastIncomingTx);
  return Promise.resolve("lastIncomingTx is " + lastIncomingTx);
}
storageSetup().then(
(res) => {},
(err) => {
  logger.error(err) ;
  process.exit(1);
});

//
// RPC setup
//

const MAINNET = config.monero.onMainNet;
const rpcPort = MAINNET ? config.monero.mainNetPort : config.monero.testNetPort;
const addressRegex = MAINNET ? new RegExp("^4([0-9]|[A-B])(.){93}$") : new RegExp("^(9|A)(.){94}$");
const minBlockHeight = config.monero.minBlockHeight; // When polling transaction we won't look below this

let stillProcessing = false; // If true then transaction polling does not continue

if (config.DEBUG && MAINNET) {
  logger.warn("config.DEBUG is true but the bot is on the MAINNET.");
}

const rpcConfig = {
  protocol: 'http',
  host: '127.0.0.1',
  path: '/json_rpc',
  port: rpcPort,
  method: 'POST',
};

const rpcClient = new RpcClient(rpcConfig);

// RPC test
rpcClient.call(
  {
    method: 'getbalance',
  },
  (err, res) => {
    if (err || res.error) {
      err = new Error("Could not connect to RPC. Check net or RPC itself.");
      logger.error(err.stack);
      throw err;
    }

    logger.info("RPC is working and responding. Bots balance is " + toNormalXMR(res.result.unlocked_balance) + " XMR");
  }
);

// See how far away minBlockHeight is from current block height
rpcClient.call(
  {
    method: 'getheight',
  },
  (err, res) => {
    if (err || res.error) {
      logger.error(res.error);
      throw err;
    }
    logger.info("minBlockHeight is " + (res.result.height - minBlockHeight) + " blocks away");
  }
);

//
// SQL setup
//

// The bot's table
const customerTable = config.sql.customerTable;
const depositTable = config.sql.depositTable;
const withdrawTable = config.sql.withdrawTable;

// When an error occurs we will replace this with another mysql.createConnection
let sqlcon;

// first is a bool (default false), if true then run some extra queries
function createSQLConnection(first) {
  logger.info("Creating new SQL connection...");

  sqlcon = mysql.createConnection({
    host: "localhost",
    user: config.sql.username,
    password: config.sql.password,
    database: config.sql.database,
  });

  logger.info("Created SQL connection, now connecting...");

  // Then connect
  sqlcon.connect((err) => {
    if (err) {
      logger.error(err);
      throw err;
    }

    logger.info("New SQL connection is connected and working.");

    if (first) {
      // Check all tables exist
      sqlcon.query("SELECT * FROM ??", [customerTable], (err, res) => {
        if (err) {
          logger.error(err.stack);
          throw err;
        }

        logger.verbose("SQL: Loaded " + res.length + " customers");
      });
      sqlcon.query("SELECT * FROM ??", [depositTable], (err, res) => {
        if (err) {
          logger.error(err.stack);
          throw err;
        }

        logger.verbose("SQL: Loaded " + res.length + " deposit transactions.");
      });
      sqlcon.query("SELECT * FROM ??", [withdrawTable], (err, res) => {
        if (err) {
          logger.error(err.stack);
          throw err;
        }

        logger.verbose("SQL: Loaded " + res.length + "  withdraw transactions");
      });
    }
  });
     
  // SQL error handling
  sqlcon.on('error', (err) => {
    logger.warn("SQL error event triggered");
    logger.warn(err);

    // See if we lost a connection
    sqlcon.connect((err) => {
      if (err.code == "PROTOCOL_ENQUEUE_HANDSHAKE_TWICE")  {
        // Do nothing, connection is still there
        logger.info("Tried to reconnect to SQL, but connection is still active.");
      }
      else {
        logger.warn("SQL error code: " + err.code);

        // Don't throw, instead create another connection
        //throw err;

        createSQLConnection();
      }
    });
  });
}

createSQLConnection(true);

//
// General functions
//

function setXMRPrice() {
  request.get({
    url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=328',
    options: { json: true },
    headers: { "X-CMC_PRO_API_KEY": config.priceApiKey },
    callback: (err, res, body) => {
      body = JSON.parse(body);

      if (err) {
        let ourerr = new Error("Could not update price, error code: " + err);
        logger.error(ourerr.stack);
        return; 
      }
      if (body.status.error_code != 0) {
        let ourerr = new Error("Could not update price, error code: " + body.status.error_code);
        logger.error(ourerr.stack);
        return;
      }

      // LOGIN
      // We wait for the bot to get a price for monero before logging in
      if (currentXMRPrice === 0) {
        client.logOn(logOnOptions);
      }

      // Can't set a summary if we arent logged in
      if (currentXMRPrice !== 0) {
        setNewSummary();
      }

      currentXMRPrice = body.data[328].quote.USD.price.toFixed(2);
      logger.info('Updated price of XMR is: $' + currentXMRPrice);
    }
  });
}

function setNewSummary() {

  // TODO: editProfile is currently broken and is not actually
  // able to change summary.
  return;

  let newSummary = "ːcsgoglobeː The only Steam bot for exchanging XMR (Monero) for CSGO keys";
  newSummary += "\n[i]This bot buys keys for [b]$" + keyPriceBuying + "[/b] and sells keys for [b]$" + keyPriceSelling + "[/b][/i]";
  newSummary += "\n[i]Current Monero price is: [b]$" + currentXMRPrice + "[/b][/i]";
  newSummary += "\n\nːcsgoglobeː This is my [b][url=https://steamcommunity.com/id/shamoidol]owner[/url][/b].";

  community.editProfile({
    summary: newSummary,
  },
  (err) => {
    if (err) {
      logger.warn("Could not change profile summary");
      logger.error(err);
      return;
    }
    logger.debug("Updated summary");
  });
}

async function replyToMessage(senderID, message) {

  let ourMessage = ""; // Sent to the user at the end

  // Prevent errors
  message = message.toLowerCase();

  // Sell calculation
  if (message.substring(0, 4) === 'sell') {
    let keysAsked = parseInt(message.substring(4));

    // Check if valid int
    if (isNaN(keysAsked)) {
      ourMessage = "Invalid key amount, try again. Example: 'sell 20'.";
    }
    else {
      let xmrToPay = trimNormalXMR( (keyPriceBuying / currentXMRPrice) * keysAsked );

      ourMessage = 'I would pay you ' + xmrToPay + ' XMR ($' + (xmrToPay*currentXMRPrice).toFixed(2) + ') for ' + keysAsked + ' keys.';
      ourMessage += '\n\nImportant: Whenever the bot sends you XMR, the Monero transaction fee (usually not that high) will be deducted from the amount sent to you.';
    }
  }

  // Buy calculation
  else if (message.substring(0, 3) === 'buy') {
    let keysAsked = parseInt(message.substring(3));

    // Check if valid int
    if (isNaN(keysAsked)) {
      ourMessage = "Invalid key amount, try again. Example: 'buy 20'.";
    }
    else {
      let xmrToPay = trimNormalXMR( (keyPriceSelling / currentXMRPrice) * keysAsked );

      ourMessage = 'You would need to pay ' + xmrToPay + ' XMR ($' + (xmrToPay*currentXMRPrice).toFixed(2) + ') for ' + keysAsked + ' keys.';
    }
  }

  // Debug with something attached
  else if (message.substring(0, 5) === 'debug') {
    ourMessage = 'Command not recognised, type "commands" to see all commands.';
    if (config.DEBUG || config.maintenance) {
      // Whatever you want to debug by command

      let currentBotBalance = await getBotBalance();
      ourMessage = "Bot's somethihg is " + toNormalXMR(currentBotBalance).toFixed(3) + " XMR.";

      let parsedOffer = parseInt(message.substring(5));
      if (!isNaN(parsedOffer)) {
        // Manually mobile-confirm
        community.acceptConfirmationForObject(config.steam.identitySecret, parsedOffer, (err) => {
          if (err) {
            logger.warn("Could not manually mobile-confirm offer " + parsedOffer);
            logger.warn(err);
          }
        });
      }

      //ourMessage = "Received.";
    }
  }

  else { switch(message) {
    case 'help':
      ourMessage = "This bot allows you to sell your CSGO keys in return for XMR (Monero), or vice versa."; 

      ourMessage += "\nTo buy CSGO keys, ask the bot for an address with the 'deposit' command, then send as much monero as you want to this address. After the bot receives the transaction (usually around 20 min), your balance with the bot will increase (check your balance with 'balance'). To withdraw your balance, send the bot an offer asking for the bots keys.";
      ourMessage += "\n\nTo sell your CSGO keys, send your keys in an offer to the bot. IMPORTANT: include your monero address in the offer description. If your offer is accepted the bot will message you with the amount sent. You should receive the Monero in about 20 min.";

      ourMessage += "\n\nCheck this bot's profile for a better explanation.\n\nOr type 'commands' to see all commands.";
      break;

    case 'commands':
      ourMessage = '"help" - How to use the bot\n';
      ourMessage += '"commands" - This message\n';
      ourMessage += '"buy <number>" - Shows how much XMR you would need to give to get this amount of keys\n';
      ourMessage += '"sell <number>" - Shows how much XMR you would get for selling this amount of keys\n';
      ourMessage += '"price" - Shows my key and XMR/USD prices\n';
      ourMessage += '"deposit" - Displays the address where you need to send XMR to buy keys.\n';
      ourMessage += '"balance" - Shows your $ balance on the bot and how many keys you can withdraw\n';
      ourMessage += '"withdraw" - Tells you how to withdraw your keys after sending XMR to to the bot\n';
      ourMessage += '"support" - Link to this bots steam group where you can request help\n';
      break;

    case 'price':
      ourMessage = "I buy keys for $" + keyPriceBuying + " and sell keys for $" + keyPriceSelling;
      ourMessage += '\nMy price for XMR is: $' + currentXMRPrice + '. It is updated every ' + secondsBetweenUpdate / 60 + ' minutes.';
      break;
    
    case 'deposit':
      ourMessage = "Send XMR to this specific address: " + await getUsersAddress(senderID);
      break;

    case 'balance':
      let ub = await getUserBalance(senderID.getSteamID64());
      ourMessage = "Your current balance is: $" + ub + ". You can withdraw up to " + (Math.floor(ub / keyPriceSelling)) + " keys.";
      break;

    case 'withdraw':
      ourMessage = "To withdraw keys from the bot, send an offer where you take items from the bot. You don't need to put anything in the offer description. If your balance is enough to pay for the keys the bot will automatically accept the offer.";
      break;

    case 'support':
      ourMessage = "For help either leave a comment on the bots profile, or create a discussion thread on the bots group. Group link is https://steamcommunity.com/groups/xmr-bot-group";
      break;

    default:
      ourMessage = 'Command not recognised, type "commands" to see all commands.';
  }
  }

  return ourMessage;
}

// This will return the users designated intergrated address if they have one,
// if not, it will generate a new one, store it, and return it.
function getUsersAddress(steamid) {

  return new Promise((resolve, reject) => {
    
    // Check whether we have this person stored
    sqlcon.query("SELECT * FROM ?? WHERE steamid = ?", [customerTable, steamid.getSteamID64()], (err, res) => {
      if (err) throw err;

      if (res[0]) {
        resolve(res[0].integrated_address);
      }
      else {
        genIntergratedAddress().then((newAddress) => {
          sqlcon.query("INSERT INTO ?? (steamid, integrated_address, balance) VALUES (?, ?, '0')", [customerTable ,steamid.getSteamID64(), newAddress], (err, res) => {
            if (err) throw err;

            resolve(newAddress);
          });
        });
      }

    });
  });
}

async function genIntergratedAddress(idToUse) {

  let ourParams = {"payment_id": ""};
  if (idToUse) {
    ourParams.payment_id = idToUse;
  }

  return new Promise((resolve, reject) => {
    rpcClient.call(
      {
        method: 'make_integrated_address',
        params: ourParams,
      },
      (err, res) => {
        if (err || res.error) {
          logger.error(res.error);
          throw res.error;
        }
        resolve(res.result.integrated_address);
      }
    );
  });
}

// Checks if item is a key, allows everything when config.DEBUG = true
function isAllowedItem(item) {
  // Why config.DEBUG is dangerous
  if (config.DEBUG) {
    return true;
  }

  // Check if correct game first
  if (item.appid != 730) {
    return false;
  }

  return config.keys.allowedKeys.includes(item.name);
}

function toAtomicXMR(nonAtomicXMR) {
  return nonAtomicXMR * Math.pow(10, 12);
}

function toNormalXMR(atomicXMR) {
  return atomicXMR * Math.pow(10, -12);
}

// Rounds up to 12 decimal points
function trimNormalXMR(normalXMR) {
  // let precision = Math.pow(10, 12);
  // return Math.round(normalXMR * precision) / precision;
  return normalXMR.toFixed(12);
}

// Gets the bots balance in atomic units
function getBotBalance() {
  return new Promise((resolve) => {
    rpcClient.call(
      {
        method: 'getbalance',
      },
      (err, res) => {
        if (err || res.error) {
          logger.error(res.error);
          throw err;
        }
        resolve(res.result.unlocked_balance);
      }
    );
  });
}

function getUserBalance(steam64id) {
  return new Promise((resolve) => {
    sqlcon.query("SELECT * FROM ?? WHERE steamid = ?", [customerTable ,steam64id], (err, res) => {
      if (err) throw err;

      if (res[0]) {
        resolve(res[0].balance);
      }
      else {
        logger.error("Could not find user", steam64id, "in db.");
        resolve(0);
      }
    });
  });
}

// Makes sure the offer is a valid deposit offer (user sending only keys etc)
// Returns {decline: true/false, declineMessage: "Error message"/null}
function isValidDeposit(offer) {
  return new Promise((resolve) => {
    let response = {decline: false, declineMessage: null};

    // Checks are in order of complexity

    // If steam is having issues, decline
    if (offer.isGlitched()) {
      logger.error("Glitched offer #", offer.id);
      response.declineMessage = "Your offer was declined because Steam is having issues right now, please try again later.";
      response.decline = true;
    }
    // Decline when we give something
    else if (offer.itemsToGive.length != 0) {
      response.declineMessage = "Your offer was declined because you took items from the bot.";
      response.decline = true;
    }
    // Decline when escrow
    else if (offer.escrowEnds != null) {
      response.declineMessage = "Your offer was declined because the offer had an escrow.";
      response.decline = true;
    }
    // Check that the address is correct
    else if (!offer.message.match(addressRegex)) {
      // User probably just forgot the include the address
      if (offer.message == "") {
        response.declineMessage = "Your offer was declined because trade offer message was empty. The message should instead include your monero address (and only your monero address).";
      }
      else {
        response.declineMessage = "Your offer was declined because the trade offer message did not contain a valid monero address. The message should only contain your address and nothing else. Check for spaces at the beginning and end of the message as well."
      }
      response.decline = true;
    }
    // Check that the offer contains only keys
    else if (!offer.itemsToReceive.every(isAllowedItem)) {
      response.declineMessage = "Your offer contained items that are not accepted. Only keys are accepted (Sticker capsule keys do not count).";
      response.decline = true;
    }

    resolve(response);
  });
}

function isValidWithdraw(offer) {
  return new Promise((resolve) => {
    let response = {decline: false, declineMessage: null};

    // Checks are in order of complexity

    // If steam is having issues, decline
    if (offer.isGlitched()) {
      logger.error("Glitched offer #", offer.id);
      response.declineMessage = "Your offer was declined because Steam is having issues right now, please try again later.";
      response.decline = true;
    }
    // Decline when we get sent something
    else if (offer.itemsToReceive.length != 0) {
      response.declineMessage = "Your offer was declined because you sent items in a withdraw.";
      response.decline = true;
    }
    // Decline when escrow
    else if (offer.escrowEnds != null) {
      response.declineMessage = "Your offer was declined because the offer had an escrow.";
      response.decline = true;
    }
    // Check that the offer contains only keys TEST
    else if (!offer.itemsToGive.every(isAllowedItem)) {
      response.declineMessage = "Your offer was declined because you asked for non-key items. Only keys are accepted (Sticker capsule keys do not count).";
      response.decline = true;
    }

    resolve(response);
  });
}

async function respondToWithdraw(offer) {
  logger.info("Responding to withdraw from " + offer.partner.getSteamID64());

  let keysGiving = offer.itemsToGive.length;

  let shouldDecline = await isValidWithdraw(offer);
  let userBalance = await getUserBalance(offer.partner.getSteamID64());
  let moneyToWithdraw = keyPriceSelling * keysGiving;

  // Check if users balance is big enough
  if (!shouldDecline.decline) {
    if (userBalance < moneyToWithdraw) {
      shouldDecline.decline = true;
      shouldDecline.declineMessage = "Your balance is $" + userBalance + " but you have asked for $" + moneyToWithdraw + " worth of keys to withdraw. Withdraw a smaller amount of keys.";
    }
  }

  // If any errors were triggered we decline the offer and send the specific reply
  if (shouldDecline.decline) {
    offer.decline((err) => {
      if (err) {
        logger.warn("Could not decline offer:");
        logger.error(err);
        return;
      }

      logger.info("Declined offer " + offer.id + " | For reason: " + shouldDecline.declineMessage);
      client.chatMessage(offer.partner, shouldDecline.declineMessage);
    });

    return;
  }

  // The users new balance after withdrawing keys
  let newBalance = userBalance - moneyToWithdraw;

  sqlcon.query("UPDATE ?? SET balance = ? WHERE steamid = ?", [customerTable ,newBalance, offer.partner.getSteamID64()], (err, res) => {
    if (err) throw err;

    logger.info("Changed " + offer.partner.getSteamID64() + "'s" + " balance from " + userBalance + " to " + newBalance);

    // Balance has been updated, now we accept the offer
    offer.accept(false, (err, status) => {
      if (err) {
        logger.warn("Could not accept offer #" + offer.id + " because:");
        logger.error(err.stack);
        client.chatMessage(offer.partner, "Your offer could not be accepted, please try again later.");
        return;
      }
      if (status == "escrow") {
        logger.warn("Offer #" + offer.id + " went into escrow.");
        return;
      }

      // More or less instantly confirm the trade 
      community.acceptConfirmationForObject(config.steam.identitySecret, offer.id, (err) => {
        if (err != null) {
          logger.warn("Could not confirm offer #" + offer.id + " because:");
          logger.error(err);
          return;
        }
      });

      // Items should be gone by this point, we can update title
      setNewTitle();

      client.chatMessage(offer.partner, "Your withdraw offer has been accepted. Thank you for using the bot!");
      commentAfterTrade(offer.partner.getSteamID64());
      inviteToGroup(offer.partner.getSteamID64());

      client.chatMessage(offer.partner, "This bot is still quite new, so if you could leave a positive comment on my profile that would help our reputation a lot!");

      //
      // Log this transaction
      //
      sqlcon.query("INSERT INTO ?? (steamid, keys_sent, balance_deducted, offer_id) VALUES (?, ?, ?, ?)", [withdrawTable, offer.partner.getSteamID64(), keysGiving, (userBalance - newBalance), offer.id], (err, res) => {
        if (err) {
          logger.error(err.stack);
          throw err;
        }

        logger.info("Succesfully logged withdraw transaction (offer id: " + offer.id + ")");
      });
    });
  });
}

async function respondToDeposit(offer) {

  let keysReceived = offer.itemsToReceive.length;
  let amount = toAtomicXMR( trimNormalXMR((keyPriceBuying / currentXMRPrice) * keysReceived) );

  // We get ALL keys here to prevent errors
  let spaceLeft = 1000 - await getKeyAmount();

  let shouldDecline = await isValidDeposit(offer);

  // Only check our balance if we passed all other checks
  if (!shouldDecline.decline) {
    // Check if we have enough monero. Checks against amount since the difference
    // is minimal and saves doing an extra rpc call
    let currentBotBalance = await getBotBalance();

    if (currentBotBalance < amount) {
      shouldDecline.decline = true;
      shouldDecline.declineMessage = "The bot does not have enough XMR for your offer. The owner has been notified and will add more soon. Please wait or try again with less keys. The bot's XMR balance is around " + toNormalXMR(currentBotBalance).toFixed(3) + " XMR.";
      logger.error("Bot does not have enough XMR for a " + toNormalXMR(amount) + " transfer");
    }
    else if (spaceLeft < keysReceived) {
      shouldDecline.decline = true;
      shouldDecline.declineMessage = "The bot does not have enough space in it's inventory right now. The owner has been informed. Try again later or try with less keys.";
      logger.error("Bot does not have enough space to accept a deposit.");
    }
  }

  // If any errors were triggered we decline the offer and send the specific reply
  if (shouldDecline.decline) {
    offer.decline((err) => {
      if (err) {
        logger.warn("Could not decline offer #" + offer.id + " because:");
        logger.error(err);
        return;
      }

      logger.info("Declined offer #" + offer.id + " | For reason: " + shouldDecline.declineMessage);
      client.chatMessage(offer.partner, shouldDecline.declineMessage);
    });

    return;
  }

  let userAddress = offer.message;

  logger.info("Beginning to accept an offer with " + keysReceived + " keys from " + offer.partner.getSteamID64());
  client.chatMessage(offer.partner, "Offer is correct, accepting now...");

  offer.accept(false, (err, status) => {
    if (err) {
      logger.warn("Could not accept offer #" + offer.id + " because:");
      logger.error(err);
      client.chatMessage(offer.partner, "Your offer could not be accepted, please try again later.");
      return;
    }
    if (status == "escrow") {
      logger.warn("Offer #" + offer.id + " went into escrow.");
      return;
    }

    logger.info("Accepted deposit offer #" + offer.id + ", now transfering " + toNormalXMR(amount) + " (-fee) XMR");

    // We don't need to confirm this offer since we are sending nothing

    // Calculate fee by making a transaction but not transmitting it
    rpcClient.call(
      {
        method: 'transfer',
        params: {
          destinations: [
            {"amount": amount, "address": userAddress}
          ],
          do_not_relay: true,
        }
    
      },
      (err, res) => {
        if (err || res.error) {
          if (err) logger.error(err);
          if (res.error) logger.error(res.error);

          // Wrong address error code
          if (res.error.code === -2) {
            logger.error(offer.partner.getSteamID64() + " provided a false address in offer #" + offer.id + " | " + toNormalXMR(amount) + " XMR was supposed to be sent to " + userAddress);

            // Tell user to seek support
            client.chatMessage(offer.partner, "The address you provided was invalid. Unfortunately the Steam offer has already been accepted. Please request support using the 'support' command. The maximum response time is within 24 hours.");

            return;
          }
          else {
            logger.error(res.error);
            throw res.error;
          }
        }

        let feeToDeduct = res.result.fee;
        logger.info("Fee to deduct is " + toNormalXMR(feeToDeduct));
        let finalAmount = amount - feeToDeduct;
        logger.info("Final amount is " + toNormalXMR(finalAmount));

        // Now actually send
        rpcClient.call(
          {
            method: 'transfer',
            params: {
              destinations: [
                {"amount": finalAmount, "address": userAddress}
              ],
            }
        
          },
          (err, res) => {
            if (err || res.error) {
              logger.error(err);
              logger.error(res.error);
            }
            
            logger.info("Successfully bought " + keysReceived + " keys from " + offer.partner.getSteamID64() + " | Sent " + toNormalXMR(finalAmount) + " XMR in return | txid: " + res.result.tx_hash + " | offer id: " + offer.id);
    
            let chatReply = "Your offer was accepted and " + toNormalXMR(amount) + " XMR (minus fee of " + toNormalXMR(feeToDeduct) + " XMR) has been sent to your address. Please keep in mind it may take up to 20 minutes for the XMR to appear in your wallet.\n\n"
            chatReply += "tx hash of transaction is: " + res.result.tx_hash;
    
            client.chatMessage(offer.partner, chatReply);
            commentAfterTrade(offer.partner.getSteamID64());
            inviteToGroup(offer.partner.getSteamID64());
    
            client.chatMessage(offer.partner, "This bot is still quite new, so if you could leave a positive comment on my profile that would help our reputation a lot!");
    
            //
            // Log this transaction
            //
            sqlcon.query("INSERT INTO ?? (steamid, keys_received, address_given, xmr_sent, offer_id) VALUES (?, ?, ?, ?, ?)", [depositTable, offer.partner.getSteamID64(), keysReceived, userAddress, toNormalXMR(amount), offer.id], (err, res) => {
              if (err) {
                logger.error(err.stack);
                throw err;
              }
    
              logger.info("Succesfully logged deposit transaction (offer id: " + offer.id + ")");
            });
          }
        );
      }
    );  
  });
}

function sortByHeight(a, b) {
  return a.height - b.height;
}

// Called every so often to check for incoming transactions, stops if stillProcessing is true
async function pollIncomingTransactions() {
  if (stillProcessing) {
    logger.warn("Stopped poll due to stillProcessing still being true");
    return;
  }

  stillProcessing = true;

  rpcClient.call(
    {
      method: 'get_transfers',
      params: {
        in: true,
        filter_by_height: true,
        min_height: minBlockHeight,
      },
    },
    async (err, res) => {
      if (err) {
        let ourerr = new Error("RPC poll error: " + err);
        logger.error(ourerr.stack);
        stillProcessing = false;
        return;
      }
      if (res.error) {
        let ourerr = new Error("RPC poll error: " + res.error);
        logger.error(ourerr.stack);
        stillProcessing = false;
        return;
      }

      let inTransactions = res.result.in;
      inTransactions.sort(sortByHeight); // ascending order of block height

      // If the most recent transaction is the last known one, we can stop
      if (inTransactions[inTransactions.length - 1].txid == lastIncomingTx) {
        logger.debug("Polled transactions and no new transactions found.");
        stillProcessing = false;
        return;
      }

      // The number of new transactions, -1 at first to confirm later
      let numOfNewTransactions = -1;

      // Find the last transaction we already processed
      for (let i = (inTransactions.length - 1); i >= 0; i--) {
        if (inTransactions[i].txid == lastIncomingTx) {
          numOfNewTransactions = (inTransactions.length - 1) - i;
          break;
        }
      }

      // Safety check
      if (numOfNewTransactions == -1) {
        logger.error("lastIncomingTx could not be found in any transfer.");
        process.exit(1);
      }
      logger.info("Found " + numOfNewTransactions + " new incoming transactions, processing...");

      // Make an array of just the new transactions
      let newTransactions = inTransactions.slice(inTransactions.length - numOfNewTransactions);

      processTransactions(newTransactions, 0);
    }
  );
}

// Recursion in order to process transactions one by one
async function processTransactions(transactions, index) {
  if (index > transactions.length - 1) {
    logger.info("Processed all transactions up to this point");
    stillProcessing = false;
    return;
  }

  let transaction = transactions[index];

  logger.info("Now processing transaction " + transaction.txid);

  if (transaction.payment_id == "0000000000000000") {
    logger.warn("Transaction " + transaction.txid + " has no payment_id, ignoring");

    await storage.setItem(lastIncomingTx_name, transaction.txid);
    lastIncomingTx = transaction.txid;

    processTransactions(transactions, index + 1);
    return;
  }

  let amountReceived = toNormalXMR(transaction.amount);
  let dollarAmountReceived = amountReceived * currentXMRPrice;
  let user; // will be a steam 64 id later
  let currentBalance; // the users current balance
  let fullAddress = await genIntergratedAddress(transaction.payment_id);

  logger.info("Received " + amountReceived + " XMR ($" + dollarAmountReceived.toFixed(2) + ") in txid " + transaction.txid);

  sqlcon.query("SELECT * FROM ?? WHERE integrated_address = ?", [customerTable ,fullAddress], async (err, res) => {
    if (err) throw err;

    if (!res[0]) {
      logger.error("Could not find user whose address is " + fullAddress + " in database while processing transaction, ignoring");

      await storage.setItem(lastIncomingTx_name, transaction.txid);
      lastIncomingTx = transaction.txid;

      processTransactions(transactions, index + 1);
      return;
    }

    user = res[0].steamid;
    currentBalance = res[0].balance;

    logger.verbose("Found user, current balance is $" +  currentBalance);

    let newBalance = currentBalance + dollarAmountReceived;

    sqlcon.query("UPDATE ?? SET balance = ? WHERE steamid = ?", [customerTable ,newBalance, user],async (err, res) => {
      if (err) throw err;
  
      logger.info("New balance for " + user + ". From " + currentBalance + " to " + newBalance);

      client.chatMessage(user, "Your transaction has been received by the bot. Use the 'balance' command to check your new balance.");

      await storage.setItem(lastIncomingTx_name, transaction.txid);
      lastIncomingTx = transaction.txid;

      logger.info("Done processing transaction " + transaction.txid);
      processTransactions(transactions, index + 1);
    });
  });
}

// Updates the bot's title (game played)
// Don't update too often otherwise it will spam people's screen
async function setNewTitle(quick) {
  // This is sometimes called after a trade, since it takes a few seconds for
  // the trade to properly go through, we wait 5 secs
  setTimeout(async () => {

    let keys = await getKeyAmount(true);
    if (typeof keys !== "number") return;

    let s = "";
    s += "B: $" + keyPriceBuying;
    s += " | S: $" + keyPriceSelling;
    s += " | " + keys + "/1000";

    if (config.maintenance) {
      s = "Maintenance";
    }

    client.gamesPlayed(s, true);
    
  }, quick ? 500 : 5000);
}

// tradable being true will return only tradable items
function getKeyAmount(tradable) {
  if (tradable !== true) {
    tradable = false;
  }
  return new Promise((resolve, reject) => {
    manager.getInventoryContents(730, 2, tradable, (err, inventory) => {
      if (err) {
        logger.warn("Could not update inventory:");
        logger.error(err.stack);
        resolve(new Error("Inventory error"));
        return;
      }

      resolve(inventory.length);
    });
  });
}

function blockUser(steam64id) {
  client.removeFriend(steam64id);
  client.blockUser(steam64id, (eresult) => {
    if (eresult != 1) {
      logger.error("Could not block " + steam64id + " due to " + eresult);
    }

    logger.info("Blocked " + steam64id);
  });
}

// Adds a user if they aren't banned, and adds them to our db
function addNewFriend(steam64id) {

  // If banned reject
  if (bannedUsers.includes(steam64id)) {
    logger.info("Not adding " + steam64id + " because he is banned");
    blockUser(sid.getSteamID64());
    return;
  }

  // Accept their request
  client.addFriend(steam64id, (err, name) => {
    if (err) throw err;
    
    logger.info("Added " + steam64id + " as a friend.");

    // Check whether we have this person already stored
    sqlcon.query("SELECT * FROM ?? WHERE steamid = ?", [customerTable, steam64id], (err, res) => {
      if (err) throw err;

      // If we don't have this person, generate an address for them and a row as well
      if (!res[0]) {
        genIntergratedAddress().then((newAddress) => {
          sqlcon.query("INSERT INTO ?? (steamid, integrated_address, balance) VALUES (?, ?, '0')", [customerTable, steam64id, newAddress], (err, res) => {
            if (err) {
              logger.error(err.stack);
              throw err;
            }
          });
        });
      }

      client.chatMessage(steam64id, "Thank you for using this bot. Type 'help' to receive more information, 'commands' to see all commands, or look at this bot's profile.");
      inviteToGroup(steam64id);
    });
  });
}

//
// All values set by this point, can begin logging into Steam and beginning to work
//

setXMRPrice(); // First call, afterwards we login (if successful)
setInterval(setXMRPrice, secondsBetweenUpdate*1000);
setInterval(pollIncomingTransactions, config.monero.transactionPoll*1000);

//client.logOn(logOnOptions);

//
// The bot will login into Steam after the first setXMRPrice call is done, otherwise offers
// could be processed with the monero price == 0
//

// Allows the bot to solve its own problem
client.setOption("promptSteamGuardCode", false);

client.on('error', (err) => {
  logger.warn("Client error:");
  logger.error(err);
  throw err;
})

client.on('loggedOn', () => {
  logger.info('Logged in on Steam.');

  client.webLogOn();

  client.setPersona(SteamUser.Steam.EPersonaState.Online);
});

client.on('steamGuard', (domain, callback, lastCodeWrong) => {

  logger.warn("steamGuard event triggered");

  if (lastCodeWrong) {
    logger.warn("Last SteamGuard code was wrong, waiting before logging in.");
  }

  // Wait otherwise we will get rate limited
  setTimeout(() => {
    callback(SteamTotp.generateAuthCode(config.steam.sharedSecret));
  }, 10000);
})

// Web session setup
client.on('webSession', (sessionid, cookies) => {
  logger.warn("webSession event triggered");

  manager.setCookies(cookies);
  community.setCookies(cookies);

  setNewSummary();

  setNewTitle(true);
  setInterval(setNewTitle, 3600*1000);
});

// This loads once when the bot launches, main purpose is to respond
// to friend requests which happened while we were offline
client.on('friendsList', () => {

  let friends = client.myFriends;
  let toAccept = {};
  let total = 0;

  for (let prop in friends) {
    if (friends[prop] === 3) {
      total++;
    }
    else if (friends[prop] === 2) {
      toAccept[prop] = friends[prop];
    }
  }

  // Accept all who sent a request while we were offline
  if (config.steam.acceptNewInvites) {
    for (let sid in toAccept) {
      addNewFriend(sid);
      total++;
    }
  }
  else {
    logger.warn("acceptNewInvites is set to false, not accepting " + Object.keys(toAccept).length + " friend requests.");
  }

  logger.warn("Bot currently has " + total + " friends");
});

// User messages us
client.on('friendMessage', (senderID, message) => {
  logger.verbose("Message from " + senderID.getSteamID64() + " | They said: " + message);

  if (config.maintenance && !config.admins.includes(senderID.getSteamID64())) {
    logger.warn("In maintenance mode so responding with notice.");
    client.chatMessage(senderID, "The bot is currently in maintenance and will not respond to anything, please try again later.");
    return;
  }

  // If banned
  if (bannedUsers.includes(senderID.getSteamID64())) {
    logger.info("Not replying to banned user " + senderID.getSteamID64());
    blockUser(senderID.getSteamID64());
    return;
  }

  replyToMessage(senderID, message).then((ourMessage) => {
    client.chatMessage(senderID, ourMessage);
  });
});

// Friend request
client.on('friendRelationship', (sid, relationship) => {

  if (!config.steam.acceptNewInvites && !config.admins.includes(sid.getSteamID64())) {
    logger.warn("Received a friend request but not accepting due to acceptNewInvites being false.");
    return;
  }

  // relationship enum https://github.com/DoctorMcKay/node-steam-user/blob/master/enums/EFriendRelationship.js

  // Friend request
  if (relationship == 2) {
    addNewFriend(sid.getSteamID64());
  }
});

// Recieve an offer
manager.on('newOffer', (offer) => {
  logger.info("New offer #" + offer.id + " from " + offer.partner.getSteamID64());
  if (config.maintenance) logger.verbose("Received offer: " + JSON.stringify(offer, null, 3));

  // MANUALLY ACCEPTING CERTAIN OFFERS BY ID
  if (config.maintenance && offer.id == "putyouridhere") {
    logger.warn("MANUALLY ACCEPTING OFFER");
    offer.accept(false, (err, status) => {
      if (err) {
        logger.warn("Could not accept offer #" + offer.id + " because:");
        logger.error(err);
        return;
      }
      if (status == "escrow") {
        logger.warn("Offer #" + offer.id + " went into escrow.");
        return;
      }
      logger.warn("Almost done with manual offer.");

      // True if we are sending anything
      if (true) {
        community.acceptConfirmationForObject(config.steam.identitySecret, offer.id, (err) => {
          if (err != null) {
            logger.warn("Could not confirm offer #" + offer.id + " because:");
            logger.error(err);
            return;
          }
          logger.warn("Accepted manual offer");
        });
      }
    });
    return;
  }

  if (config.maintenance && !config.admins.includes(offer.partner.getSteamID64())) {
    logger.warn("Ignoring offer because in maintenance mode");
    return;
  }

  // If banned
  if (bannedUsers.includes(offer.partner.getSteamID64())) {
    logger.info("Not replying to banned user's (" + offer.partner.getSteamID64() + ") offer");
    blockUser(offer.partner.getSteamID64());

    offer.decline((err) => {
      if (err) {
        logger.warn("Could not decline offer:");
        logger.error(err);
        return;
      }

      logger.info("Declined offer #" + offer.id + " due to user being banned");
    });

    return;
  }

  //
  // Only one side of the offer should be sending items. If we are sending, assume
  // it is a withdraw offer, if they are sending, assume it is a deposit offer
  //

  if (offer.itemsToGive.length != 0 && offer.itemsToReceive.length != 0) {
    offer.decline((err) => {
      if (err) {
        logger.warn("Could not decline offer:");
        logger.error(err);
        return;
      }

      logger.info("Declined offer #" + offer.id + " due to having items on both sides");
      client.chatMessage(offer.partner, "Your offer has been declined. Only the bot or you should send items, not both.");
    });
  }
  else if (offer.itemsToGive.length != 0) {
    respondToWithdraw(offer);
  }
  else if (offer.itemsToReceive.length != 0) {
    respondToDeposit(offer);
  }
});
