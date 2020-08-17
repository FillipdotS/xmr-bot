// Config
const config = require('./config');
const logger = require('./logger.js');

// Specific steam libraries
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

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

// For manual login
logger.info(SteamTotp.generateAuthCode(config.steam.sharedSecret));
//


// custom stuff
let login = false;
let offerToConfirm = "";


if (login) {
    client.logOn(logOnOptions);
}

client.on('error', (err) => {
	logger.error("Client error: " + err.stack);
	throw err;
})

client.on('loggedOn', () => {
	logger.info('Logged in on Steam.');

	client.setPersona(SteamUser.Steam.EPersonaState.Online);
});

// Web session setup
client.on('webSession', (sessionid, cookies) => {
	manager.setCookies(cookies);
    community.setCookies(cookies);
    
	// Custom action probably goes under here
	
	// mobile confirm an offer
	community.acceptConfirmationForObject(config.steam.identitySecret, offerToConfirm, (err) => {
		if (err) {
			logger.warn("Could not manually mobile-confirm offer " + parsedOffer);
			logger.warn(err);
		}
		logger.info("confirmed offer");
		process.exit(1);
	});


});