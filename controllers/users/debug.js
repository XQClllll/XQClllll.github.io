const UserLoginDebugController = UserBaseController.extend({
	xdom: true,

	elements: {
		'input[name=username]': 'inp_username',
		'input[name=password]': 'inp_password',
	},

	buttons: false,
	formclass: 'user-login',

	init: function() {
		turtl.push_title('Login help', '/users/login');
		this.render();
	},

	state: {
		results: null,
	},

	render: function() {
		return this.html(view.render('users/debug', {
			results: this.state.results,
		}))
	},

	submit: function(e) {
		if(e) e.stop();
		var username = this.inp_username.get('value');
		var password = this.inp_password.get('value');
		if(!username || !password) {
			barfr.barf('Please anter both a username and password');
			return;
		}

		var core_debug = turtl.core.send('user:migrate-auth-debug', username, password);
		var v6_debug_v0 = v6_login_debug.get_auth(username, password, {old: true});
		var v6_debug_v1 = v6_login_debug.get_auth(username, password, {old: false});
		return Promise.all([core_debug, v6_debug_v0, v6_debug_v1])
			.bind(this)
			.spread(function(core, v6_v0, v6_v1) {
				this.state.results = {
					core_v0: core.v0.join('\n'),
					core_v1: core.v1.join('\n'),
					v6_v0: v6_v0[1].join('\n'),
					v6_v1: v6_v1[1].join('\n'),
				};
				this.render();
			});
	}
});

function login_debug() {
	turtl.route('/users/debug');
}

// -----------------------------------------------------------------------------
// tcrypt/sjcl/user shite from v0.6
// -----------------------------------------------------------------------------
const v6_login_debug = (function() {
"use strict";

// define error(s) used by tcrypt
var extend_error = function(extend, errname)
{
	var err = function() {
		var tmp = extend.apply(this, arguments);
		tmp.name = this.name = errname;

		this.stack = tmp.stack
		this.message = tmp.message

		return this;
	};
	err.prototype = Object.create(extend.prototype, { constructor: { value: err } });
	return err;
}
var TcryptError = extend_error(Error, 'TcryptError');
var TcryptAuthFailed = extend_error(TcryptError, 'TcryptAuthFailed');
var TcryptBadBrowser = extend_error(TcryptError, 'TcryptBadBrowser');

var tcrypt = {
	// -------------------------------------------------------------------------
	// NOTE: never inject items into these lists. only append them!!!!
	// NOTE: these lists can only support 256 items each!!!!
	// -------------------------------------------------------------------------
	cipher_index: [
		'AES'
	],
	block_index: [
		'CBC',
		'GCM'
	],
	padding_index: [
		'AnsiX923',
		'PKCS7'
	],
	// this list holds items used by tcrypt.derive_keys to turn a master key
	// (which is the main key passed into tcrypt.ecrypt/decrypt) into two keys:
	// a key for encryption/decryption, and a key for HMAC verification.
	//
	// Format:
	//   [hasher, iterations, length]
	kdf_index: [
		['SHA256', 2, 64]
	],
	// -------------------------------------------------------------------------

	current_version: 5,		// current serialization version

	// serialization options (array index values for the tcrypt.*_index arrays)
	default_cipher: 0,
	default_block: 1,
	default_padding: 1,
	default_kdf_mode: 0,	// corresponds to tcrypt.kdf_index

	// define some getters.
	get_cipher: function(ciphername) { return sjcl.cipher[ciphername.toLowerCase()]; },
	get_block_mode: function(blockmode) { return sjcl.mode[blockmode.toLowerCase()]; },
	get_padding: function(padding) { return ''; },	// now unused
	get_hasher: function(hasher) { return sjcl.hash[hasher.toLowerCase()]; },

	/**
	 * This is the original Turtl encryption format
	 *
	 *   [payload (base64)]:i[initial vector]
	 *
	 * It was stupid because it forced things to be in base64, which increases
	 * size by 2-3x. Binary storage was not an option.
	 */
	old_formatter: {
		stringify: function (cipherParams)
		{
			// create json object with ciphertext
			var crypto = btoa(cipherParams.ciphertext);

			// optionally add iv
			if(cipherParams.iv) crypto += ':i' + sjcl.codec.hex.fromBits(tcrypt.bin_to_words(cipherParams.iv));

			// stringify json object
			return crypto;
		},

		parse: function(crypto)
		{
			// parse json string
			var parts = crypto.split(/:/g);
			var params = {
				ciphertext: sjcl.codec.base64.toBits(parts[0]),
				cipher: 'AES',
				block_mode: 'CBC',
				padding: 'AnsiX923'
			}
			parts.shift();
			parts.forEach(function(p) {
				if(p.match(/^i/)) params.iv = sjcl.codec.hex.toBits(p.slice(1));
			});
			return params;
		}
	},

	/**
	 * Given a serialization version and a payload description *string*, pull
	 * out any pertinant information (cipher, block mode, padding, etc).
	 */
	decode_payload_description: function(version, desc_str)
	{
		if(typeof(desc_str) != 'string') desc_str = tcrypt.words_to_bin(desc_str);

		if(version >= 1)
		{
			var cipher_index = desc_str.charCodeAt(0);
			var block_index = desc_str.charCodeAt(1);
			if(version <= 4)
			{
				var kdf_mode = desc_str.charCodeAt(3);
				var padding_index = desc_str.charCodeAt(2);
			}
		}

		var ret = {
			cipher: tcrypt.cipher_index[cipher_index],
			block_mode: tcrypt.block_index[block_index],
		};
		if(typeof(kdf_mode) != 'undefined') ret.kdf_mode = kdf_mode;
		if(typeof(padding_index) != 'undefined') ret.padding = padding_index;

		return ret;
	},

	/**
	 * Given a serialization version and a set of information about how a
	 * payload is serialized, return a payload description string
	 */
	encode_payload_description: function(version, options)
	{
		if(!options || !options.cipher || !options.block_mode)
		{
			throw new TcryptError('tcrypt.encode_payload_description: must provide cipher, block_mode in options');
		}

		if(version >= 1)
		{
			var cipher = tcrypt.cipher_index.indexOf(options.cipher);
			var block_mode = tcrypt.block_index.indexOf(options.block_mode);
			var desc = String.fromCharCode(cipher) +
								String.fromCharCode(block_mode);
			if(version <= 4)
			{
				var padding = tcrypt.padding_index.indexOf(options.padding);
				desc	+=	String.fromCharCode(padding);
				desc	+=	String.fromCharCode(options.kdf_mode);
			}
		}

		return desc;
	},

	/**
	 * Authenticate a crypto payload via HMAC
	 *
	 * NOTE: this is now vestigial...it is only used for decryption data from
	 * version 4 and below because as of version 5, all encrption/decryption is
	 * done with authenticated block modes (GCM, CCM, ...) so key derivation
	 * from a master key and manually HMACing our data isn't needed.
	 */
	authenticate_payload: function(passphrase, version, payload_description, iv, ciphertext)
	{
		payload_description = tcrypt.words_to_bin(payload_description);
		var payload = version 
			+ payload_description.length
			+ payload_description
			+ tcrypt.words_to_bin(iv)
			+ tcrypt.words_to_bin(ciphertext);
		var hmac = new sjcl.misc.hmac(passphrase, tcrypt.get_hasher('SHA256'));
		var hash = tcrypt.words_to_bin(hmac.mac(tcrypt.bin_to_words(payload)));
		return hash;
	},

	/**
	 * Given a master key and a set of options, derive two sub-keys: one for
	 * encryption/decryption and one for HMAC generation.
	 *
	 * NOTE: this is now vestigial...it is only used for decryption data from
	 * version 4 and below because as of version 5, all encrption/decryption is
	 * done with authenticated block modes (GCM, CCM, ...) so key derivation
	 * from a master key and manually HMACing our data isn't needed.
	 */
	derive_keys: function(master_key, options)
	{
		options || (options = {});

		var hasher = options.hasher || tcrypt.get_hasher('SHA1');
		var iterations = options.iterations || 50;
		var key_size = options.key_size || 64;

		var master_bin = tcrypt.words_to_bin(master_key);
		var both_keys = tcrypt.key(master_bin, null, {
			hasher: hasher,
			iterations: iterations,
			key_size: key_size
		});

		// split the resulting key down the middle, first half is crypto key,
		// second half is hmac key
		var enc_key = sjcl.bitArray.bitSlice(both_keys, 0, 256);
		var hmac_key = sjcl.bitArray.bitSlice(both_keys, 256);

		return {crypto: enc_key, hmac: hmac_key};
	},

	/**
	 * Turtl encryption serialization format is as follows:
	 *
	 *   |-2 bytes-| |-1 byte----| |-N bytes-----------| |-16 bytes-| |-N bytes----|
	 *   | version | |desc length| |payload description| |    IV    | |payload data|
	 *
	 * - version tells us the serialization version. although it will probably
	 *   not get over 255, it has two bytes just in case. never say never.
	 * - desc length is the length of the payload description, which may change
	 *   in length from version to version.
	 * - payload description tells us what algorithm/format the encryption uses.
	 *   for instance, it could be AES+CBC, or Twofish+CBC, etc etc. payload
	 *   description encoding/length may change from version to version.
	 * - IV is the initial vector of the payload, in binary form
	 * - payload data is our actual data, encrypted.
	 */
	deserialize: function(enc, options)
	{
		options || (options = {});

		var is_str = typeof(enc) == 'string';
		var get_bytes = function(data, idx, length)
		{
			var sliceargs = length ? [data, idx * 8, (idx * 8) + (length * 8)] : [data, idx * 8];
			return is_str ? tcrypt.bin_to_words(data.substr(idx, length)) : sjcl.bitArray.bitSlice.apply(this, sliceargs);
		};
		var get_byte = function(data, idx)
		{
			return is_str ? data.charCodeAt(idx) : sjcl.bitArray.extract(data, idx * 8, 8); 
		}

		// define an index we increment to keep track of deserialization
		var idx = 0;

		// if the first character is not 0, either Turtl has come a really long
		// way (and had over 255 serialization versions) or we're at the very
		// first version, which just uses Base64.
		var version = (get_byte(enc, idx) << 8) + get_byte(enc, idx + 1);
		idx	+=	2;

		// TODO: if we ever get above 1000 versions, change this. The lowest
		// allowable Base64 message is '++', which translates to 11,051 but for
		// now we'll play it safe and cap at 1K
		if(version > 1000)
		{
			return Object.merge(tcrypt.old_formatter.parse(enc), {
				version: 0,
				hmac: null,
			});
		}

		// NOTE: we only HMAC for versions <= 4 because 5 and above uses only
		// authenticated block modes
		if(version <= 4)
		{
			// grab HMAC for auth
			var hmac = get_bytes(enc, idx, 32);
			idx	+=	32;

			// allow returning JUST the HMAC hash. can be very useful.
			if(options.hmac_only) return hmac;
		}

		// grab the payload description and decode it
		var desc_length = get_byte(enc, idx);
		var desc_str = get_bytes(enc, idx+1, desc_length);
		idx	+=	desc_length + 1;

		// grab the IV
		var iv = get_bytes(enc, idx, 16);
		idx	+=	16;

		if(options.raw) return get_bytes(enc, 0, idx);

		// finally, the encrypted data
		var ciphertext = get_bytes(enc, idx);

		var params = {
			version: version,
			desc: desc_str,
			iv: iv,
			ciphertext: ciphertext
		};
		if(typeof(hmac) != 'undefined')
		{
			params.hmac = hmac;
		}
		return params;
	},

	/**
	 * Serialize our encrypted data into the standard format (see the comments
	 * above the deserialize method).
	 *
	 * `enc` is our *encrypted* ciphertext, options contains information
	 * explaining how enc was created (iv, cipher, block mode, padding, etc).
	 */
	serialize: function(enc, options)
	{
		options || (options = {});

		var version = options.version;

		// support serializing the old version if needed (auth, for example)
		if(version === 0)
		{
			return tcrypt.old_formatter.stringify({
				ciphertext: enc,
				iv: options.iv
			});
		}

		// create initial string, with two version bytes
		var serialized = String.fromCharCode(version >> 8) + String.fromCharCode(version & 255);

		// NOTE: we only HMAC for versions <= 4 because 5 and above uses only
		// authenticated block modes
		if(version <= 4)
		{
			serialized		+=	options.hmac;
		}

		// create/append our description length and description
		serialized		+=	String.fromCharCode(options.desc.length)
		serialized		+=	options.desc;

		// append the IV
		serialized		+=	options.iv;

		// last but definitely not least, the actual crypto data
		serialized		+=	enc;

		return serialized;
	},

	/**
	 * Encrypt data with key.
	 *
	 * `options` allows specifying of cipher ('AES'/'Twofish'), block mode
	 * ('CBC', 'CFB'), padding mode ('AnsiX923'/'PKCS7'), and serialization
	 * version (defaults to tcrypt.current_version).
	 *
	 * Note that unless using version === 0 (the original serialization version,
	 * still used in some places for backwards compatibility), the given `key`
	 * is used to derive two other keys (and is otherwise not used directly): a
	 * crypto key (used to encrypt the data) and an HMAC key used to protect the
	 * ciphertext against tampering.
	 *
	 * This function returns a binary string of the serialized encrypted data.
	 * All information needed to decrypt the string is encoded in the string.
	 * See tcrypt.deserialize for more information.
	 */
	encrypt: function(key, data, options)
	{
		options || (options = {});

		// because of some errors in judgement, in some cases keys were UTF8
		// encoded early-on. this should remain here until all keys for all data
		// for all users are not UTF8 encoded...so, forever probably.
		if(sjcl.bitArray.bitLength(key) / 8 > 32)
		{
			key = tcrypt.bin_to_words(sjcl.codec.utf8String.fromBits(key));
		}

		// if we didn't specify cipher, block_mode, or padding in the options,
		// use the tcrypt defaults.
		var cipher = options.cipher || tcrypt.cipher_index[tcrypt.default_cipher];
		var block_mode = options.block_mode || tcrypt.block_index[tcrypt.default_block];
		if(['gcm', 'ccm'].indexOf(block_mode.toLowerCase()) < 0)
		{
			throw new TcryptError('Bad mode: '+ block_mode +' (only authenticated modes allowed: gcm, ccm)');
		}

		// force latest version. only decryption needs to support old versions.
		var version = options.version;
		if(version !== 0 || (version > 0 && version <= 4)) version = tcrypt.current_version;

		var block_class = tcrypt.get_block_mode(block_mode);
		var iv = options.iv || tcrypt.iv();

		if(version === 0)
		{
			var cipher = new sjcl.cipher.aes(key);
			var ciphertext = sjcl.mode.cbc.encrypt(
				cipher,
				sjcl.codec.utf8String.toBits(data),
				iv,
				null,
				{ascii: true}	// added this in for backwards compat
			);
			var enc = tcrypt.words_to_bin(ciphertext);
			var formatted = tcrypt.serialize(enc, {
				version: version,
				iv: tcrypt.words_to_bin(iv)
			});
			return formatted;
		}

		var utf8_random = options.utf8_random || tcrypt.random_number();
		if(typeof data == 'string')
		{
			// utf8 encoding section. up til version 4, all encrypted strings were
			// utf8 encoded. this is the easy option, but sometimes doubles the size
			// of the ciphertext for binary data. not cool.
			//
			// version 4 and up, we detect if the string has utf8 bytes *before*
			// blindly encoding. we also prepend a byte to the beginning of the data
			// that lets us know whether or not we encoded the data. it would be a
			// giveaway to just use 0 or 1, so instead we pick a random byte. if the
			// data is not utf8 encoded, the byte is between 0 and 127, if it is
			// encoded, it's betwene 128 and 255. this lets us detect the encoding
			// on decrypt without leaking any information in the ciphertext.
			//
			// NOTE: the first byte currently contains one useful bit and seven
			// random bits. these random bits could be used to describe the pre-
			// encrypted payload in other ways. for now, just the first bit is used.
			if(tcrypt.is_utf8(data))
			{
				var utf8byte = String.fromCharCode(Math.floor(utf8_random * (256 - 128)) + 128);
				data = utf8byte + tcrypt.utf8_encode(data);
			}
			else
			{
				var utf8byte = String.fromCharCode(Math.floor(utf8_random * (256 - 128)));
				data = utf8byte + data;
			}
		}
		else
		{
			var utf8byte = String.fromCharCode(Math.floor(utf8_random * (256 - 128)));
			data = sjcl.bitArray.concat([sjcl.bitArray.partial(8, utf8byte)], data);
		}

		// generate serialized description
		var desc = tcrypt.encode_payload_description(version, {
			cipher: cipher,
			block_mode: block_mode
		});

		// serialize our ciphertext along with all the options used to create it
		// into the serialization format. note that we set the ciphertext to ''
		// because we're going to manually append it after encryption. this way
		// we can use the serialized description data as part of the auth data
		// so it can't be tampered with.
		var formatted = tcrypt.serialize('', {
			version: version,
			desc: desc,
			iv: tcrypt.words_to_bin(iv)
		});
		// convert to word array
		formatted = tcrypt.bin_to_words(formatted);

		// our message auth data is every part of our message other than the
		// ciphertext (version, desc, desc length, iv, etc).
		var auth = formatted;
		var cipherclass = tcrypt.get_cipher(cipher);
		var cipher = new cipherclass(key);
		var ciphertext = block_class.encrypt(
			cipher,
			typeof data == 'string' ? tcrypt.bin_to_words(data) : data,
			iv,
			auth,
			128
		);

		// TODO: investigate performance tweaks here? doing a concat (depending
		// on the bit length) may require shifting the *entire* ciphertext words
		// over, which on a large file could be pretty expensive.
		var words = sjcl.bitArray.concat(formatted, ciphertext);
		if(options.uint_array) return new Uint8Array(sjcl.codec.bytes.fromBits(words));
		return words;
	},

	/**
	 * Decrypt data with key.
	 *
	 * The given `encrypted` data is first deserialized from Turtl's standard
	 * format, which gives us serialization version, HMAC authentication hash,
	 * ciphertext description (which includes the algorithm, padding mode, block
	 * mode, and key derivation method), and the actual ciphertext.
	 *
	 * We then create a decryption key and an HMAC key (based on the "master"
	 * key passed in) using the key derivation method in the description.
	 *
	 * The HMAC included in the payload is then checked against the HMAC we get
	 * from hashing the version, description, iv, and ciphertext with the HMAC
	 * password we got from the master key.
	 *
	 * If the hashes match, great, decrypt the ciphertext and return the result.
	 * If the hashes do not match, an exception is thrown, blocking decryption.
	 *
	 * Note that all of the above deserialization/authentication is skipped if
	 * the payload has a version === 0 (Turtl's old serialization format), in
	 * which case the data is just decrypted without question.
	 */
	decrypt: function(key, encrypted, options)
	{
		options || (options = {});

		// because of some errors in judgement, in some cases keys were UTF8
		// encoded early-on. this should remain here until all keys for all data
		// for all users are not UTF8 encoded...so, forever probably.
		if(sjcl.bitArray.bitLength(key) / 8 > 32)
		{
			key = tcrypt.bin_to_words(sjcl.codec.utf8String.fromBits(key));
		}

		// handle byte arrays
		if(encrypted instanceof Uint8Array)
		{
			encrypted = sjcl.codec.bytes.toBits(encrypted);
		}

		// split a serialized crypto message into a set of params and options,
		// including what cipher we used to encrypt it, block mode, padding, iv,
		// ciphertext (obvis).
		var params = tcrypt.deserialize(encrypted);
		var version = params.version;

		if(version === 0)
		{
			var desc = {
				cipher: 'aes',
				block_mode: 'cbc'
			};
		}
		else
		{
			var desc = tcrypt.decode_payload_description(params.version, params.desc);
		}

		var block_mode = this.get_block_mode(desc.block_mode);
		var iv = params.iv;
		var cipherclass = tcrypt.get_cipher(desc.cipher);

		if(version <= 4)
		{
			if(version === 0)
			{
				// we're deserializing/decrypting an old-version message. use the
				// values passed to us by tcrypt.old_formatter.parse to form a
				// description object. note in this case, we skip HMAC generation
				// and authentication, and use the master key as the crypto key.
				var crypto_key = key;
				var hmac_key = null;
			}
			else
			{
				// generate an encryption key and an authentication key from the
				// master key `key`.
				var kdf_entry = tcrypt.kdf_index[desc.kdf_mode];
				var keys = tcrypt.derive_keys(key, {
					hasher: tcrypt.get_hasher(kdf_entry[0]),
					iterations: kdf_entry[1],
					key_size: kdf_entry[2]
				});
				var crypto_key = keys.crypto;
				var hmac_key = keys.hmac;
			}

			if(params.version !== 0)
			{
				// build/authenticate HMAC
				var hmac = tcrypt.words_to_bin(params.hmac);
				if(hmac && hmac_key)
				{
					if(hmac !== tcrypt.authenticate_payload(hmac_key, version, params.desc, params.iv, params.ciphertext))
					{
						throw new TcryptAuthFailed('Authentication error. This data has been tampered with (or the key is incorrect).');
					}
				}
			}

			var cipher = new cipherclass(crypto_key);
			var decrypted = block_mode.decrypt(
				cipher,
				params.ciphertext,
				iv
			);
		}
		else if(version >= 5)
		{
			// our message auth data is every part of our message other than the
			// ciphertext (version, desc, desc length, iv, etc).
			var auth = tcrypt.deserialize(encrypted, {raw: true});
			var crypto_key = key;
			var cipher = new cipherclass(crypto_key);
			try
			{
				var decrypted = block_mode.decrypt(
					cipher,
					params.ciphertext,
					iv,
					auth,
					128
				);
			}
			catch(e)
			{
				if(e instanceof sjcl.exception.corrupt)
				{
					throw new TcryptAuthFailed('Authentication error. This data has been tampered with (or the key is incorrect).');
				}
				else
				{
					throw e;
				}
			}
		}

		// detect our UTF8 encoding
		if(version >= 4)
		{
			var utf8byte = (decrypted[0] >> 24) & 255;
			var is_utf8 = utf8byte >= 128;
			decrypted = sjcl.bitArray.bitSlice(decrypted, 8);
		}
		else
		{
			var is_utf8 = true;
		}

		if(options.raw) return decrypted;
		if(options.uint_array) return new Uint8Array(sjcl.codec.bytes.fromBits(decrypted));

		// now perform our UTF8 conversion
		var decode = decrypted;
		try
		{
			if(is_utf8) decode = sjcl.codec.utf8String.fromBits(decode);
			else decode = tcrypt.words_to_bin(decode);
		}
		catch(e)
		{
			throw new TcryptError('UTF8 decoding failed: '+ e.message);
		}

		return decode;
	},

	/**
	 * Generate a key from a password/salt
	 */
	key: function(passphrase, salt, options)
	{
		options || (options = {});

		var iterations = (options.iterations || 400);
		var hasher = (options.hasher || tcrypt.get_hasher('SHA1'));
		var key_size = (options.key_size || 32);
		var passphrase = tcrypt.bin_to_words(passphrase);
		var salt = tcrypt.bin_to_words(salt || '');

		var key = sjcl.misc.pbkdf2(passphrase, salt, iterations, key_size * 8, function(p) {
			return new sjcl.misc.hmac(p, hasher);
		});
		
		return key;
	},

	/**
	 * Generate a key using the webcrypto api (async, obvis)
	 */
	key_native: function(passphrase, salt, options)
	{
		options || (options = {});
		var iterations = (options.iterations || 400);
		var key_size = (options.key_size || 32);
		var hasher = (options.hasher || 'SHA-256');

		var convert = function(str)
		{
			var bytes = sjcl.codec.bytes.fromBits(sjcl.codec.utf8String.toBits(str));
			return new Uint8Array(bytes).buffer;
		};
		passphrase = convert(passphrase);
		salt = convert(salt);

		if(!window.crypto || !window.crypto.subtle)
		{
			return Promise.reject(new TcryptBadBrowser('your browser sucks (hi, safari)'));
		}
		return window.crypto.subtle.importKey('raw', passphrase, {name: 'PBKDF2'}, false, ['deriveKey'])
			.then(function(base) {
				return window.crypto.subtle.deriveKey({
					name: 'PBKDF2',
					salt: salt,
					iterations: iterations,
					hash: hasher
				}, base, {name: 'AES-GCM', length: key_size * 8}, true, ['encrypt', 'decrypt']);
			})
			.then(function(key) {
				return window.crypto.subtle.exportKey('raw', key);
			})
			.then(function(bytes) {
				return sjcl.codec.bytes.toBits(new Uint8Array(bytes));
			});
	},

	/**
	 * convert word array to base64
	 */
	to_base64: function(words)
	{
		return sjcl.codec.base64.fromBits(words);
	},

	/**
	 * convert base64 to word array
	 */
	from_base64: function(str)
	{
		return sjcl.codec.base64.toBits(str);
	},

	/**
	 * convert word array to hex
	 */
	to_hex: function(words)
	{
		return sjcl.codec.hex.fromBits(words);
	},

	/**
	 * convert hex to word array
	 */
	from_hex: function(str)
	{
		return sjcl.codec.hex.toBits(str);
	},

	/**
	 * Given a binary key, convert to base64 string
	 */
	key_to_string: function(keywords)
	{
		return tcrypt.to_base64(keywords);
	},

	/**
	 * Given a Base64 encoded key, convert it to a binary key (keys MUST be in
	 * binary format when using tcrypt.encrypt/decrypt)
	 */
	key_to_bin: function(keystring)
	{
		return tcrypt.from_base64(keystring);
	},

	/**
	 * Is sjcl.codec.utf8string.fromBits, but without UTF8 conversion
	 */
	words_to_bin: function(arr)
	{
		var out = "", bl = sjcl.bitArray.bitLength(arr), i, tmp;
		for (i=0; i<bl/8; i++) {
			if ((i&3) === 0) {
				tmp = arr[i/4];
			}
			out += String.fromCharCode(tmp >>> 24);
			tmp <<= 8;
		}
		return out;
	},

	/**
	 * Is sjcl.codec.utf8string.toBits, but without UTF8 conversion
	 */
	bin_to_words: function(str)
	{
		var out = [], i, tmp=0;
		for (i=0; i<str.length; i++) {
			tmp = tmp << 8 | str.charCodeAt(i);
			if ((i&3) === 3) {
				out.push(tmp);
				tmp = 0;
			}
		}
		if (i&3) {
			out.push(sjcl.bitArray.partial(8*(i&3), tmp));
		}
		return out;
	},

	/**
	 * utf8 encode 
	 */
	utf8_encode: function(data)
	{
		return unescape(encodeURIComponent(data));
	},

	/**
	 * utf8 decode 
	 */
	utf8_decode: function(data)
	{
		return decodeURIComponent(escape(data));
	},

	/**
	 * test for utf8
	 */
	is_utf8: function(str)
	{
		return /[^\u0000-\u00ff]/.test(str);
	},

	/**
	 * Generate N random bytes, returned as a WordArray
	 */
	random_bytes: function(nBytes)
	{
		// NOTE: this was taken directly from CryptoJS' random() function, but
		// updated to use tcrypt.random_number() instead of Math.random().
		var words = [];
		for (var i = 0; i < nBytes; i += 4) {
			words.push((tcrypt.random_number() * 0x100000000) | 0);
		}
		return words;
	},

	/**
	 * Generate an initial vector. If given a seed, will generate it based off
	 * the seed, otherwise will return a random 16 byte WordArray
	 */
	iv: function(value)
	{
		// if no seed given, return 16 random bytes
		if(!value) return tcrypt.random_bytes(16);

		if(value.length < 16)
		{
			// if the IV seed is less than 16 bytes, append random data
			value	+=	tcrypt.words_to_bin(tcrypt.random_bytes(16));
		}
		if(value.length > 16)
		{
			// only grab 16 bytes of seed
			value = value.slice(0, 16)
		}
		return tcrypt.bin_to_words(value);
	},

	/**
	 * Generate a random 256bit key.
	 */
	random_key: function(options)
	{
		return tcrypt.random_bytes(32);
	},

	/**
	 * SHA256 the given data.
	 */
	hash: function(data, options)
	{
		options || (options = {});

		var hash = tcrypt.get_hasher('SHA256').hash(data);
		if(options.raw) return tcrypt.words_to_bin(hash);
		return sjcl.codec.hex.fromBits(hash);
	},

	/**
	 * Generate a random number between 0 and 1.
	 *
	 * Uses window.crypto for random generation, and if not available, bitches
	 * about how insecure your browser is.
	 */
	random_number: function()
	{
		if((typeof(window) == 'undefined' || !window.crypto) && sjcl && sjcl.random)
		{
			return sjcl.random.randomWords(1, 10)[0] / (Math.pow(2, 32) - 1);
		}
		else if(window.crypto.getRandomValues)
		{
			// TODO: handle QuotaExceededError error in FF (maybe the same in chrome)
			return window.crypto.getRandomValues(new Uint32Array(1))[0] / (Math.pow(2, 32) - 1);
		}
		else
		{
			throw new TcryptError('no available PRNG');
		}
	},

	/**
	 * Generate a random SHA256 hash
	 */
	random_hash: function()
	{
		return tcrypt.hash(Date.now() + tcrypt.uuid());
	},

	/**
	 * Generate a *random* UUID.
	 */
	uuid: function()
	{
		// taken from stackoverflow.com, modified to use tcrypt's random generator
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
			var r = tcrypt.random_number()*16|0;
			var v = c == 'x' ? r : (r&0x3|0x8);
			return v.toString(16);
		});
	}
};

tcrypt.asym = {
	current_version: 1,

	/**
	 * PGP encrypt a message
	 */
	encrypt: function(pubkey, data, options)
	{
		options || (options = {});

		return new Promise(function(resolve, reject) {
			var rawkey = openpgp.key.readArmored(pubkey);

			openpgp.encryptMessage(rawkey.keys, data)
				.then(function(msg) {
					resolve(msg);
				})
				.catch(reject);
		});
	},

	decrypt: function(privkey, data, options)
	{
		options || (options = {});

		return new Promise(function(resolve, reject) {
			var rawkey = openpgp.key.readArmored(privkey).keys[0];
			rawkey.decrypt();
			var msg = openpgp.message.readArmored(data);

			openpgp.decryptMessage(rawkey, msg)
				.then(function(plain) {
					resolve(plain);
				})
				.catch(reject);
		});
	},

	keygen: function(options)
	{
		options || (options = {});
		return new Promise(function(resolve, reject) {
			var opts = {
				numBits: (options.keysize || 4096),
				userId: options.user_id,
				passphrase: null
			};

			openpgp.generateKeyPair(opts)
				.then(function(keypair){
					resolve({
						private: keypair.privateKeyArmored,
						public: keypair.publicKeyArmored
					});
				})
				.catch(reject);
		});
	}
};

tcrypt.asym_old = {
	current_version: 1,

	/**
	 * Standard serialization for asymetric data
	 *
	 *   |-2 bytes-| |-96 bytes-| |-N bytes----|
	 *   | version | |   tag    | |payload data|
	 */
	serialize: function(enc, options)
	{
		options || (options = {});

		var version = options.version;
		var serialized = String.fromCharCode(version >> 8) + String.fromCharCode(version & 255);
		serialized		+=	options.tag;
		serialized		+=	enc;

		return serialized;
	},

	/**
	 * Standard deserialization for asymetric data. See tcrypt.asym_old.serialize.
	 */
	deserialize: function(enc, options)
	{
		options || (options = {});

		var is_str = typeof(enc) == 'string';
		var get_bytes = function(data, idx, length)
		{
			var sliceargs = length ? [data, idx * 8, (idx * 8) + (length * 8)] : [data, idx * 8];
			return is_str ? tcrypt.bin_to_words(data.substr(idx, length)) : sjcl.bitArray.bitSlice.apply(this, sliceargs);
		};
		var get_byte = function(data, idx)
		{
			return is_str ? data.charCodeAt(idx) : sjcl.bitArray.extract(data, idx * 8, 8); 
		}

		// define an index we increment to keep track of deserialization
		var idx = 0;

		// if the first character is not 0, either Turtl has come a really long
		// way (and had over 255 serialization versions) or we're at the very
		// first version, which just uses Base64.
		var version = (get_byte(enc, idx) << 8) + get_byte(enc, idx + 1);
		idx	+=	2;

		// get the message tag
		var tag = get_bytes(enc, idx, 96);
		idx	+=	96;

		if(options.raw) return get_bytes(enc, 0, idx);

		// finally, the encrypted data
		var ciphertext = get_bytes(enc, idx);

		var params = {
			version: version,
			tag: tag,
			ciphertext: ciphertext
		};
		return params;
	},

	/**
	 * Encrypt data via ECC.
	 *
	 * Creates a key from the given binary, and uses it to extract a tag and an
	 * AES (256bit) key. Encrypts the given data with the AES key, then wraps
	 * the message up (version, tag, key) using tcrypt.asym_old.serialize so the
	 * whole thing can be returned as one binary blob.
	 */
	encrypt: function(key_bin, data, options)
	{
		options || (options = {});

		var version = tcrypt.asym_old.current_version;
		var point = sjcl.ecc.curves.c384.fromBits(key_bin);
		var key = new sjcl.ecc.elGamal.publicKey(sjcl.ecc.curves.c384, point)
		var kem = key.kem(10);
		var symkey = kem.key;
		var tag = kem.tag;

		var ciphertext = tcrypt.encrypt(symkey, data);
		var serialized = tcrypt.asym_old.serialize('', {
			version: version,
			tag: tcrypt.words_to_bin(tag)
		});
		serialized = tcrypt.bin_to_words(serialized);

		// TODO: find a better way to concat?
		return sjcl.bitArray.concat(serialized, ciphertext);
	},

	/**
	 * Decrypt data via ECC.
	 *
	 * Uses tcrypt.asym_old.deserialize to extract the tag and ciphertext, then
	 * extracts the AES key using the private key + tag. The cipher text is then
	 * decrypted and returned.
	 */
	decrypt: function(key_bin, data, options)
	{
		options || (options = {});

		var key = new sjcl.ecc.elGamal.secretKey(sjcl.ecc.curves.c384, sjcl.bn.fromBits(key_bin));
		var version = tcrypt.asym_old.current_version;
		var params = tcrypt.asym_old.deserialize(data);
		var symkey = key.unkem(params.tag);

		return tcrypt.decrypt(symkey, params.ciphertext, options);
	},

	/**
	 * Generate a new ECC keypair
	 */
	generate_ecc_keys: function()
	{
		var keys = sjcl.ecc.elGamal.generateKeys(384, 10);
		return {public: keys.pub._point.toBits(), private: keys.sec.get()};
	}
};

/** @fileOverview Javascript cryptography implementation.
 *
 * Crush to remove comments, shorten variable names and
 * generally reduce transmission size.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

"use strict";
/*jslint indent: 2, bitwise: false, nomen: false, plusplus: false, white: false, regexp: false */
/*global document, window, escape, unescape, module, require, Uint32Array */

/** @namespace The Stanford Javascript Crypto Library, top-level namespace. */
var sjcl = {
  /** @namespace Symmetric ciphers. */
  cipher: {},

  /** @namespace Hash functions.  Right now only SHA256 is implemented. */
  hash: {},

  /** @namespace Key exchange functions.  Right now only SRP is implemented. */
  keyexchange: {},
  
  /** @namespace Block cipher modes of operation. */
  mode: {},

  /** @namespace Miscellaneous.  HMAC and PBKDF2. */
  misc: {},
  
  /**
   * @namespace Bit array encoders and decoders.
   *
   * @description
   * The members of this namespace are functions which translate between
   * SJCL's bitArrays and other objects (usually strings).  Because it
   * isn't always clear which direction is encoding and which is decoding,
   * the method names are "fromBits" and "toBits".
   */
  codec: {},
  
  /** @namespace Exceptions. */
  exception: {
    /** @constructor Ciphertext is corrupt. */
    corrupt: function(message) {
      this.toString = function() { return "CORRUPT: "+this.message; };
      this.message = message;
    },
    
    /** @constructor Invalid parameter. */
    invalid: function(message) {
      this.toString = function() { return "INVALID: "+this.message; };
      this.message = message;
    },
    
    /** @constructor Bug or missing feature in SJCL. @constructor */
    bug: function(message) {
      this.toString = function() { return "BUG: "+this.message; };
      this.message = message;
    },

    /** @constructor Something isn't ready. */
    notReady: function(message) {
      this.toString = function() { return "NOT READY: "+this.message; };
      this.message = message;
    }
  }
};

if(typeof module !== 'undefined' && module.exports){
  module.exports = sjcl;
}
/** @fileOverview Low-level AES implementation.
 *
 * This file contains a low-level implementation of AES, optimized for
 * size and for efficiency on several browsers.  It is based on
 * OpenSSL's aes_core.c, a public-domain implementation by Vincent
 * Rijmen, Antoon Bosselaers and Paulo Barreto.
 *
 * An older version of this implementation is available in the public
 * domain, but this one is (c) Emily Stark, Mike Hamburg, Dan Boneh,
 * Stanford University 2008-2010 and BSD-licensed for liability
 * reasons.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/**
 * Schedule out an AES key for both encryption and decryption.  This
 * is a low-level class.  Use a cipher mode to do bulk encryption.
 *
 * @constructor
 * @param {Array} key The key as an array of 4, 6 or 8 words.
 *
 * @class Advanced Encryption Standard (low-level interface)
 */
sjcl.cipher.aes = function (key) {
  if (!this._tables[0][0][0]) {
    this._precompute();
  }
  
  var i, j, tmp,
    encKey, decKey,
    sbox = this._tables[0][4], decTable = this._tables[1],
    keyLen = key.length, rcon = 1;
  
  if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
    throw new sjcl.exception.invalid("invalid aes key size");
  }
  
  this._key = [encKey = key.slice(0), decKey = []];
  
  // schedule encryption keys
  for (i = keyLen; i < 4 * keyLen + 28; i++) {
    tmp = encKey[i-1];
    
    // apply sbox
    if (i%keyLen === 0 || (keyLen === 8 && i%keyLen === 4)) {
      tmp = sbox[tmp>>>24]<<24 ^ sbox[tmp>>16&255]<<16 ^ sbox[tmp>>8&255]<<8 ^ sbox[tmp&255];
      
      // shift rows and add rcon
      if (i%keyLen === 0) {
        tmp = tmp<<8 ^ tmp>>>24 ^ rcon<<24;
        rcon = rcon<<1 ^ (rcon>>7)*283;
      }
    }
    
    encKey[i] = encKey[i-keyLen] ^ tmp;
  }
  
  // schedule decryption keys
  for (j = 0; i; j++, i--) {
    tmp = encKey[j&3 ? i : i - 4];
    if (i<=4 || j<4) {
      decKey[j] = tmp;
    } else {
      decKey[j] = decTable[0][sbox[tmp>>>24      ]] ^
                  decTable[1][sbox[tmp>>16  & 255]] ^
                  decTable[2][sbox[tmp>>8   & 255]] ^
                  decTable[3][sbox[tmp      & 255]];
    }
  }
};

sjcl.cipher.aes.prototype = {
  // public
  /* Something like this might appear here eventually
  name: "AES",
  blockSize: 4,
  keySizes: [4,6,8],
  */
  
  /**
   * Encrypt an array of 4 big-endian words.
   * @param {Array} data The plaintext.
   * @return {Array} The ciphertext.
   */
  encrypt:function (data) { return this._crypt(data,0); },
  
  /**
   * Decrypt an array of 4 big-endian words.
   * @param {Array} data The ciphertext.
   * @return {Array} The plaintext.
   */
  decrypt:function (data) { return this._crypt(data,1); },
  
  /**
   * The expanded S-box and inverse S-box tables.  These will be computed
   * on the client so that we don't have to send them down the wire.
   *
   * There are two tables, _tables[0] is for encryption and
   * _tables[1] is for decryption.
   *
   * The first 4 sub-tables are the expanded S-box with MixColumns.  The
   * last (_tables[01][4]) is the S-box itself.
   *
   * @private
   */
  _tables: [[[],[],[],[],[]],[[],[],[],[],[]]],

  /**
   * Expand the S-box tables.
   *
   * @private
   */
  _precompute: function () {
   var encTable = this._tables[0], decTable = this._tables[1],
       sbox = encTable[4], sboxInv = decTable[4],
       i, x, xInv, d=[], th=[], x2, x4, x8, s, tEnc, tDec;

    // Compute double and third tables
   for (i = 0; i < 256; i++) {
     th[( d[i] = i<<1 ^ (i>>7)*283 )^i]=i;
   }
   
   for (x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
     // Compute sbox
     s = xInv ^ xInv<<1 ^ xInv<<2 ^ xInv<<3 ^ xInv<<4;
     s = s>>8 ^ s&255 ^ 99;
     sbox[x] = s;
     sboxInv[s] = x;
     
     // Compute MixColumns
     x8 = d[x4 = d[x2 = d[x]]];
     tDec = x8*0x1010101 ^ x4*0x10001 ^ x2*0x101 ^ x*0x1010100;
     tEnc = d[s]*0x101 ^ s*0x1010100;
     
     for (i = 0; i < 4; i++) {
       encTable[i][x] = tEnc = tEnc<<24 ^ tEnc>>>8;
       decTable[i][s] = tDec = tDec<<24 ^ tDec>>>8;
     }
   }
   
   // Compactify.  Considerable speedup on Firefox.
   for (i = 0; i < 5; i++) {
     encTable[i] = encTable[i].slice(0);
     decTable[i] = decTable[i].slice(0);
   }
  },
  
  /**
   * Encryption and decryption core.
   * @param {Array} input Four words to be encrypted or decrypted.
   * @param dir The direction, 0 for encrypt and 1 for decrypt.
   * @return {Array} The four encrypted or decrypted words.
   * @private
   */
  _crypt:function (input, dir) {
    if (input.length !== 4) {
      throw new sjcl.exception.invalid("invalid aes block size");
    }
    
    var key = this._key[dir],
        // state variables a,b,c,d are loaded with pre-whitened data
        a = input[0]           ^ key[0],
        b = input[dir ? 3 : 1] ^ key[1],
        c = input[2]           ^ key[2],
        d = input[dir ? 1 : 3] ^ key[3],
        a2, b2, c2,
        
        nInnerRounds = key.length/4 - 2,
        i,
        kIndex = 4,
        out = [0,0,0,0],
        table = this._tables[dir],
        
        // load up the tables
        t0 = table[0],
        t1 = table[1],
        t2 = table[2],
        t3 = table[3],
        sbox = table[4];
 
    // Inner rounds.  Cribbed from OpenSSL.
    for (i = 0; i < nInnerRounds; i++) {
      a2 = t0[a>>>24] ^ t1[b>>16 & 255] ^ t2[c>>8 & 255] ^ t3[d & 255] ^ key[kIndex];
      b2 = t0[b>>>24] ^ t1[c>>16 & 255] ^ t2[d>>8 & 255] ^ t3[a & 255] ^ key[kIndex + 1];
      c2 = t0[c>>>24] ^ t1[d>>16 & 255] ^ t2[a>>8 & 255] ^ t3[b & 255] ^ key[kIndex + 2];
      d = t0[d>>>24] ^ t1[a>>16 & 255] ^ t2[b>>8 & 255] ^ t3[c & 255] ^ key[kIndex + 3];
      kIndex += 4;
      a=a2; b=b2; c=c2;
    }
        
    // Last round.
    for (i = 0; i < 4; i++) {
      out[dir ? 3&-i : i] =
        sbox[a>>>24      ]<<24 ^ 
        sbox[b>>16  & 255]<<16 ^
        sbox[c>>8   & 255]<<8  ^
        sbox[d      & 255]     ^
        key[kIndex++];
      a2=a; a=b; b=c; c=d; d=a2;
    }
    
    return out;
  }
};

/** @fileOverview Arrays of bits, encoded as arrays of Numbers.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace Arrays of bits, encoded as arrays of Numbers.
 *
 * @description
 * <p>
 * These objects are the currency accepted by SJCL's crypto functions.
 * </p>
 *
 * <p>
 * Most of our crypto primitives operate on arrays of 4-byte words internally,
 * but many of them can take arguments that are not a multiple of 4 bytes.
 * This library encodes arrays of bits (whose size need not be a multiple of 8
 * bits) as arrays of 32-bit words.  The bits are packed, big-endian, into an
 * array of words, 32 bits at a time.  Since the words are double-precision
 * floating point numbers, they fit some extra data.  We use this (in a private,
 * possibly-changing manner) to encode the number of bits actually  present
 * in the last word of the array.
 * </p>
 *
 * <p>
 * Because bitwise ops clear this out-of-band data, these arrays can be passed
 * to ciphers like AES which want arrays of words.
 * </p>
 */
sjcl.bitArray = {
  /**
   * Array slices in units of bits.
   * @param {bitArray} a The array to slice.
   * @param {Number} bstart The offset to the start of the slice, in bits.
   * @param {Number} bend The offset to the end of the slice, in bits.  If this is undefined,
   * slice until the end of the array.
   * @return {bitArray} The requested slice.
   */
  bitSlice: function (a, bstart, bend) {
    a = sjcl.bitArray._shiftRight(a.slice(bstart/32), 32 - (bstart & 31)).slice(1);
    return (bend === undefined) ? a : sjcl.bitArray.clamp(a, bend-bstart);
  },

  /**
   * Extract a number packed into a bit array.
   * @param {bitArray} a The array to slice.
   * @param {Number} bstart The offset to the start of the slice, in bits.
   * @param {Number} length The length of the number to extract.
   * @return {Number} The requested slice.
   */
  extract: function(a, bstart, blength) {
    // FIXME: this Math.floor is not necessary at all, but for some reason
    // seems to suppress a bug in the Chromium JIT.
    var x, sh = Math.floor((-bstart-blength) & 31);
    if ((bstart + blength - 1 ^ bstart) & -32) {
      // it crosses a boundary
      x = (a[bstart/32|0] << (32 - sh)) ^ (a[bstart/32+1|0] >>> sh);
    } else {
      // within a single word
      x = a[bstart/32|0] >>> sh;
    }
    return x & ((1<<blength) - 1);
  },

  /**
   * Concatenate two bit arrays.
   * @param {bitArray} a1 The first array.
   * @param {bitArray} a2 The second array.
   * @return {bitArray} The concatenation of a1 and a2.
   */
  concat: function (a1, a2) {
    if (a1.length === 0 || a2.length === 0) {
      return a1.concat(a2);
    }
    
    var out, i, last = a1[a1.length-1], shift = sjcl.bitArray.getPartial(last);
    if (shift === 32) {
      return a1.concat(a2);
    } else {
      return sjcl.bitArray._shiftRight(a2, shift, last|0, a1.slice(0,a1.length-1));
    }
  },

  /**
   * Find the length of an array of bits.
   * @param {bitArray} a The array.
   * @return {Number} The length of a, in bits.
   */
  bitLength: function (a) {
    var l = a.length, x;
    if (l === 0) { return 0; }
    x = a[l - 1];
    return (l-1) * 32 + sjcl.bitArray.getPartial(x);
  },

  /**
   * Truncate an array.
   * @param {bitArray} a The array.
   * @param {Number} len The length to truncate to, in bits.
   * @return {bitArray} A new array, truncated to len bits.
   */
  clamp: function (a, len) {
    if (a.length * 32 < len) { return a; }
    a = a.slice(0, Math.ceil(len / 32));
    var l = a.length;
    len = len & 31;
    if (l > 0 && len) {
      a[l-1] = sjcl.bitArray.partial(len, a[l-1] & 0x80000000 >> (len-1), 1);
    }
    return a;
  },

  /**
   * Make a partial word for a bit array.
   * @param {Number} len The number of bits in the word.
   * @param {Number} x The bits.
   * @param {Number} [0] _end Pass 1 if x has already been shifted to the high side.
   * @return {Number} The partial word.
   */
  partial: function (len, x, _end) {
    if (len === 32) { return x; }
    return (_end ? x|0 : x << (32-len)) + len * 0x10000000000;
  },

  /**
   * Get the number of bits used by a partial word.
   * @param {Number} x The partial word.
   * @return {Number} The number of bits used by the partial word.
   */
  getPartial: function (x) {
    return Math.round(x/0x10000000000) || 32;
  },

  /**
   * Compare two arrays for equality in a predictable amount of time.
   * @param {bitArray} a The first array.
   * @param {bitArray} b The second array.
   * @return {boolean} true if a == b; false otherwise.
   */
  equal: function (a, b) {
    if (sjcl.bitArray.bitLength(a) !== sjcl.bitArray.bitLength(b)) {
      return false;
    }
    var x = 0, i;
    for (i=0; i<a.length; i++) {
      x |= a[i]^b[i];
    }
    return (x === 0);
  },

  /** Shift an array right.
   * @param {bitArray} a The array to shift.
   * @param {Number} shift The number of bits to shift.
   * @param {Number} [carry=0] A byte to carry in
   * @param {bitArray} [out=[]] An array to prepend to the output.
   * @private
   */
  _shiftRight: function (a, shift, carry, out) {
    var i, last2=0, shift2;
    if (out === undefined) { out = []; }
    
    for (; shift >= 32; shift -= 32) {
      out.push(carry);
      carry = 0;
    }
    if (shift === 0) {
      return out.concat(a);
    }
    
    for (i=0; i<a.length; i++) {
      out.push(carry | a[i]>>>shift);
      carry = a[i] << (32-shift);
    }
    last2 = a.length ? a[a.length-1] : 0;
    shift2 = sjcl.bitArray.getPartial(last2);
    out.push(sjcl.bitArray.partial(shift+shift2 & 31, (shift + shift2 > 32) ? carry : out.pop(),1));
    return out;
  },
  
  /** xor a block of 4 words together.
   * @private
   */
  _xor4: function(x,y) {
    return [x[0]^y[0],x[1]^y[1],x[2]^y[2],x[3]^y[3]];
  }
};
/** @fileOverview Bit array codec implementations.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */
 
/** @namespace UTF-8 strings */
sjcl.codec.utf8String = {
  /** Convert from a bitArray to a UTF-8 string. */
  fromBits: function (arr) {
    var out = "", bl = sjcl.bitArray.bitLength(arr), i, tmp;
    for (i=0; i<bl/8; i++) {
      if ((i&3) === 0) {
        tmp = arr[i/4];
      }
      out += String.fromCharCode(tmp >>> 24);
      tmp <<= 8;
    }
    return decodeURIComponent(escape(out));
  },
  
  /** Convert from a UTF-8 string to a bitArray. */
  toBits: function (str) {
    str = unescape(encodeURIComponent(str));
    var out = [], i, tmp=0;
    for (i=0; i<str.length; i++) {
      tmp = tmp << 8 | str.charCodeAt(i);
      if ((i&3) === 3) {
        out.push(tmp);
        tmp = 0;
      }
    }
    if (i&3) {
      out.push(sjcl.bitArray.partial(8*(i&3), tmp));
    }
    return out;
  }
};
/** @fileOverview Bit array codec implementations.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace Hexadecimal */
sjcl.codec.hex = {
  /** Convert from a bitArray to a hex string. */
  fromBits: function (arr) {
    var out = "", i, x;
    for (i=0; i<arr.length; i++) {
      out += ((arr[i]|0)+0xF00000000000).toString(16).substr(4);
    }
    return out.substr(0, sjcl.bitArray.bitLength(arr)/4);//.replace(/(.{8})/g, "$1 ");
  },
  /** Convert from a hex string to a bitArray. */
  toBits: function (str) {
    var i, out=[], len;
    str = str.replace(/\s|0x/g, "");
    len = str.length;
    str = str + "00000000";
    for (i=0; i<str.length; i+=8) {
      out.push(parseInt(str.substr(i,8),16)^0);
    }
    return sjcl.bitArray.clamp(out, len*4);
  }
};

/** @fileOverview Bit array codec implementations.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace Base64 encoding/decoding */
sjcl.codec.base64 = {
  /** The base64 alphabet.
   * @private
   */
  _chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  
  /** Convert from a bitArray to a base64 string. */
  fromBits: function (arr, _noEquals, _url) {
    var out = "", i, bits=0, c = sjcl.codec.base64._chars, ta=0, bl = sjcl.bitArray.bitLength(arr);
    if (_url) {
      c = c.substr(0,62) + '-_';
    }
    for (i=0; out.length * 6 < bl; ) {
      out += c.charAt((ta ^ arr[i]>>>bits) >>> 26);
      if (bits < 6) {
        ta = arr[i] << (6-bits);
        bits += 26;
        i++;
      } else {
        ta <<= 6;
        bits -= 6;
      }
    }
    while ((out.length & 3) && !_noEquals) { out += "="; }
    return out;
  },
  
  /** Convert from a base64 string to a bitArray */
  toBits: function(str, _url) {
    str = str.replace(/\s|=/g,'');
    var out = [], i, bits=0, c = sjcl.codec.base64._chars, ta=0, x;
    if (_url) {
      c = c.substr(0,62) + '-_';
    }
    for (i=0; i<str.length; i++) {
      x = c.indexOf(str.charAt(i));
      if (x < 0) {
        throw new sjcl.exception.invalid("this isn't base64!");
      }
      if (bits > 26) {
        bits -= 26;
        out.push(ta ^ x>>>bits);
        ta = x << (32-bits);
      } else {
        bits += 6;
        ta ^= x << (32-bits);
      }
    }
    if (bits&56) {
      out.push(sjcl.bitArray.partial(bits&56, ta, 1));
    }
    return out;
  }
};

sjcl.codec.base64url = {
  fromBits: function (arr) { return sjcl.codec.base64.fromBits(arr,1,1); },
  toBits: function (str) { return sjcl.codec.base64.toBits(str,1); }
};
/** @fileOverview Bit array codec implementations.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace Arrays of bytes */
sjcl.codec.bytes = {
  /** Convert from a bitArray to an array of bytes. */
  fromBits: function (arr) {
    var out = [], bl = sjcl.bitArray.bitLength(arr), i, tmp;
    for (i=0; i<bl/8; i++) {
      if ((i&3) === 0) {
        tmp = arr[i/4];
      }
      out.push(tmp >>> 24);
      tmp <<= 8;
    }
    return out;
  },
  /** Convert from an array of bytes to a bitArray. */
  toBits: function (bytes) {
    var out = [], i, tmp=0;
    for (i=0; i<bytes.length; i++) {
      tmp = tmp << 8 | bytes[i];
      if ((i&3) === 3) {
        out.push(tmp);
        tmp = 0;
      }
    }
    if (i&3) {
      out.push(sjcl.bitArray.partial(8*(i&3), tmp));
    }
    return out;
  }
};
/** @fileOverview Javascript SHA-256 implementation.
 *
 * An older version of this implementation is available in the public
 * domain, but this one is (c) Emily Stark, Mike Hamburg, Dan Boneh,
 * Stanford University 2008-2010 and BSD-licensed for liability
 * reasons.
 *
 * Special thanks to Aldo Cortesi for pointing out several bugs in
 * this code.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/**
 * Context for a SHA-256 operation in progress.
 * @constructor
 * @class Secure Hash Algorithm, 256 bits.
 */
sjcl.hash.sha256 = function (hash) {
  if (!this._key[0]) { this._precompute(); }
  if (hash) {
    this._h = hash._h.slice(0);
    this._buffer = hash._buffer.slice(0);
    this._length = hash._length;
  } else {
    this.reset();
  }
};

/**
 * Hash a string or an array of words.
 * @static
 * @param {bitArray|String} data the data to hash.
 * @return {bitArray} The hash value, an array of 16 big-endian words.
 */
sjcl.hash.sha256.hash = function (data) {
  return (new sjcl.hash.sha256()).update(data).finalize();
};

sjcl.hash.sha256.prototype = {
  /**
   * The hash's block size, in bits.
   * @constant
   */
  blockSize: 512,
   
  /**
   * Reset the hash state.
   * @return this
   */
  reset:function () {
    this._h = this._init.slice(0);
    this._buffer = [];
    this._length = 0;
    return this;
  },
  
  /**
   * Input several words to the hash.
   * @param {bitArray|String} data the data to hash.
   * @return this
   */
  update: function (data) {
    if (typeof data === "string") {
      data = sjcl.codec.utf8String.toBits(data);
    }
    var i, b = this._buffer = sjcl.bitArray.concat(this._buffer, data),
        ol = this._length,
        nl = this._length = ol + sjcl.bitArray.bitLength(data);
    for (i = 512+ol & -512; i <= nl; i+= 512) {
      this._block(b.splice(0,16));
    }
    return this;
  },
  
  /**
   * Complete hashing and output the hash value.
   * @return {bitArray} The hash value, an array of 8 big-endian words.
   */
  finalize:function () {
    var i, b = this._buffer, h = this._h;

    // Round out and push the buffer
    b = sjcl.bitArray.concat(b, [sjcl.bitArray.partial(1,1)]);
    
    // Round out the buffer to a multiple of 16 words, less the 2 length words.
    for (i = b.length + 2; i & 15; i++) {
      b.push(0);
    }
    
    // append the length
    b.push(Math.floor(this._length / 0x100000000));
    b.push(this._length | 0);

    while (b.length) {
      this._block(b.splice(0,16));
    }

    this.reset();
    return h;
  },

  /**
   * The SHA-256 initialization vector, to be precomputed.
   * @private
   */
  _init:[],
  /*
  _init:[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],
  */
  
  /**
   * The SHA-256 hash key, to be precomputed.
   * @private
   */
  _key:[],
  /*
  _key:
    [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
     0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
     0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
     0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
     0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
     0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
     0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
     0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2],
  */


  /**
   * Function to precompute _init and _key.
   * @private
   */
  _precompute: function () {
    var i = 0, prime = 2, factor;

    function frac(x) { return (x-Math.floor(x)) * 0x100000000 | 0; }

    outer: for (; i<64; prime++) {
      for (factor=2; factor*factor <= prime; factor++) {
        if (prime % factor === 0) {
          // not a prime
          continue outer;
        }
      }
      
      if (i<8) {
        this._init[i] = frac(Math.pow(prime, 1/2));
      }
      this._key[i] = frac(Math.pow(prime, 1/3));
      i++;
    }
  },
  
  /**
   * Perform one cycle of SHA-256.
   * @param {bitArray} words one block of words.
   * @private
   */
  _block:function (words) {  
    var i, tmp, a, b,
      w = words.slice(0),
      h = this._h,
      k = this._key,
      h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3],
      h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];

    /* Rationale for placement of |0 :
     * If a value can overflow is original 32 bits by a factor of more than a few
     * million (2^23 ish), there is a possibility that it might overflow the
     * 53-bit mantissa and lose precision.
     *
     * To avoid this, we clamp back to 32 bits by |'ing with 0 on any value that
     * propagates around the loop, and on the hash state h[].  I don't believe
     * that the clamps on h4 and on h0 are strictly necessary, but it's close
     * (for h4 anyway), and better safe than sorry.
     *
     * The clamps on h[] are necessary for the output to be correct even in the
     * common case and for short inputs.
     */
    for (i=0; i<64; i++) {
      // load up the input word for this round
      if (i<16) {
        tmp = w[i];
      } else {
        a = w[(i+1 ) & 15];
        b = w[(i+14) & 15];
        tmp = w[i&15] = ((a>>>7  ^ a>>>18 ^ a>>>3  ^ a<<25 ^ a<<14) + 
                         (b>>>17 ^ b>>>19 ^ b>>>10 ^ b<<15 ^ b<<13) +
                         w[i&15] + w[(i+9) & 15]) | 0;
      }
      
      tmp = (tmp + h7 + (h4>>>6 ^ h4>>>11 ^ h4>>>25 ^ h4<<26 ^ h4<<21 ^ h4<<7) +  (h6 ^ h4&(h5^h6)) + k[i]); // | 0;
      
      // shift register
      h7 = h6; h6 = h5; h5 = h4;
      h4 = h3 + tmp | 0;
      h3 = h2; h2 = h1; h1 = h0;

      h0 = (tmp +  ((h1&h2) ^ (h3&(h1^h2))) + (h1>>>2 ^ h1>>>13 ^ h1>>>22 ^ h1<<30 ^ h1<<19 ^ h1<<10)) | 0;
    }

    h[0] = h[0]+h0 | 0;
    h[1] = h[1]+h1 | 0;
    h[2] = h[2]+h2 | 0;
    h[3] = h[3]+h3 | 0;
    h[4] = h[4]+h4 | 0;
    h[5] = h[5]+h5 | 0;
    h[6] = h[6]+h6 | 0;
    h[7] = h[7]+h7 | 0;
  }
};


/** @fileOverview Javascript SHA-512 implementation.
 *
 * This implementation was written for CryptoJS by Jeff Mott and adapted for
 * SJCL by Stefan Thomas.
 *
 * CryptoJS (c) 2009???2012 by Jeff Mott. All rights reserved.
 * Released with New BSD License
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 * @author Jeff Mott
 * @author Stefan Thomas
 */

/**
 * Context for a SHA-512 operation in progress.
 * @constructor
 * @class Secure Hash Algorithm, 512 bits.
 */
sjcl.hash.sha512 = function (hash) {
  if (!this._key[0]) { this._precompute(); }
  if (hash) {
    this._h = hash._h.slice(0);
    this._buffer = hash._buffer.slice(0);
    this._length = hash._length;
  } else {
    this.reset();
  }
};

/**
 * Hash a string or an array of words.
 * @static
 * @param {bitArray|String} data the data to hash.
 * @return {bitArray} The hash value, an array of 16 big-endian words.
 */
sjcl.hash.sha512.hash = function (data) {
  return (new sjcl.hash.sha512()).update(data).finalize();
};

sjcl.hash.sha512.prototype = {
  /**
   * The hash's block size, in bits.
   * @constant
   */
  blockSize: 1024,
   
  /**
   * Reset the hash state.
   * @return this
   */
  reset:function () {
    this._h = this._init.slice(0);
    this._buffer = [];
    this._length = 0;
    return this;
  },
  
  /**
   * Input several words to the hash.
   * @param {bitArray|String} data the data to hash.
   * @return this
   */
  update: function (data) {
    if (typeof data === "string") {
      data = sjcl.codec.utf8String.toBits(data);
    }
    var i, b = this._buffer = sjcl.bitArray.concat(this._buffer, data),
        ol = this._length,
        nl = this._length = ol + sjcl.bitArray.bitLength(data);
    for (i = 1024+ol & -1024; i <= nl; i+= 1024) {
      this._block(b.splice(0,32));
    }
    return this;
  },
  
  /**
   * Complete hashing and output the hash value.
   * @return {bitArray} The hash value, an array of 16 big-endian words.
   */
  finalize:function () {
    var i, b = this._buffer, h = this._h;

    // Round out and push the buffer
    b = sjcl.bitArray.concat(b, [sjcl.bitArray.partial(1,1)]);

    // Round out the buffer to a multiple of 32 words, less the 4 length words.
    for (i = b.length + 4; i & 31; i++) {
      b.push(0);
    }

    // append the length
    b.push(0);
    b.push(0);
    b.push(Math.floor(this._length / 0x100000000));
    b.push(this._length | 0);

    while (b.length) {
      this._block(b.splice(0,32));
    }

    this.reset();
    return h;
  },

  /**
   * The SHA-512 initialization vector, to be precomputed.
   * @private
   */
  _init:[],

  /**
   * Least significant 24 bits of SHA512 initialization values.
   *
   * Javascript only has 53 bits of precision, so we compute the 40 most
   * significant bits and add the remaining 24 bits as constants.
   *
   * @private
   */
  _initr: [ 0xbcc908, 0xcaa73b, 0x94f82b, 0x1d36f1, 0xe682d1, 0x3e6c1f, 0x41bd6b, 0x7e2179 ],

  /*
  _init:
  [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
   0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179],
  */

  /**
   * The SHA-512 hash key, to be precomputed.
   * @private
   */
  _key:[],

  /**
   * Least significant 24 bits of SHA512 key values.
   * @private
   */
  _keyr:
  [0x28ae22, 0xef65cd, 0x4d3b2f, 0x89dbbc, 0x48b538, 0x05d019, 0x194f9b, 0x6d8118,
   0x030242, 0x706fbe, 0xe4b28c, 0xffb4e2, 0x7b896f, 0x1696b1, 0xc71235, 0x692694,
   0xf14ad2, 0x4f25e3, 0x8cd5b5, 0xac9c65, 0x2b0275, 0xa6e483, 0x41fbd4, 0x1153b5,
   0x66dfab, 0xb43210, 0xfb213f, 0xef0ee4, 0xa88fc2, 0x0aa725, 0x03826f, 0x0e6e70,
   0xd22ffc, 0x26c926, 0xc42aed, 0x95b3df, 0xaf63de, 0x77b2a8, 0xedaee6, 0x82353b,
   0xf10364, 0x423001, 0xf89791, 0x54be30, 0xef5218, 0x65a910, 0x71202a, 0xbbd1b8,
   0xd2d0c8, 0x41ab53, 0x8eeb99, 0x9b48a8, 0xc95a63, 0x418acb, 0x63e373, 0xb2b8a3,
   0xefb2fc, 0x172f60, 0xf0ab72, 0x6439ec, 0x631e28, 0x82bde9, 0xc67915, 0x72532b,
   0x26619c, 0xc0c207, 0xe0eb1e, 0x6ed178, 0x176fba, 0xc898a6, 0xf90dae, 0x1c471b,
   0x047d84, 0xc72493, 0xc9bebc, 0x100d4c, 0x3e42b6, 0x657e2a, 0xd6faec, 0x475817],

  /*
  _key:
  [0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
   0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
   0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
   0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
   0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
   0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
   0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
   0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
   0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
   0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
   0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
   0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
   0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
   0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
   0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
   0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
   0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
   0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
   0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
   0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817],
  */

  /**
   * Function to precompute _init and _key.
   * @private
   */
  _precompute: function () {
    // XXX: This code is for precomputing the SHA256 constants, change for
    //      SHA512 and re-enable.
    var i = 0, prime = 2, factor;

    function frac(x)  { return (x-Math.floor(x)) * 0x100000000 | 0; }
    function frac2(x) { return (x-Math.floor(x)) * 0x10000000000 & 0xff; }

    outer: for (; i<80; prime++) {
      for (factor=2; factor*factor <= prime; factor++) {
        if (prime % factor === 0) {
          // not a prime
          continue outer;
        }
      }

      if (i<8) {
        this._init[i*2] = frac(Math.pow(prime, 1/2));
        this._init[i*2+1] = (frac2(Math.pow(prime, 1/2)) << 24) | this._initr[i];
      }
      this._key[i*2] = frac(Math.pow(prime, 1/3));
      this._key[i*2+1] = (frac2(Math.pow(prime, 1/3)) << 24) | this._keyr[i];
      i++;
    }
  },

  /**
   * Perform one cycle of SHA-512.
   * @param {bitArray} words one block of words.
   * @private
   */
  _block:function (words) {
    var i, wrh, wrl,
        w = words.slice(0),
        h = this._h,
        k = this._key,
        h0h = h[ 0], h0l = h[ 1], h1h = h[ 2], h1l = h[ 3],
        h2h = h[ 4], h2l = h[ 5], h3h = h[ 6], h3l = h[ 7],
        h4h = h[ 8], h4l = h[ 9], h5h = h[10], h5l = h[11],
        h6h = h[12], h6l = h[13], h7h = h[14], h7l = h[15];

    // Working variables
    var ah = h0h, al = h0l, bh = h1h, bl = h1l,
        ch = h2h, cl = h2l, dh = h3h, dl = h3l,
        eh = h4h, el = h4l, fh = h5h, fl = h5l,
        gh = h6h, gl = h6l, hh = h7h, hl = h7l;

    for (i=0; i<80; i++) {
      // load up the input word for this round
      if (i<16) {
        wrh = w[i * 2];
        wrl = w[i * 2 + 1];
      } else {
        // Gamma0
        var gamma0xh = w[(i-15) * 2];
        var gamma0xl = w[(i-15) * 2 + 1];
        var gamma0h =
          ((gamma0xl << 31) | (gamma0xh >>> 1)) ^
          ((gamma0xl << 24) | (gamma0xh >>> 8)) ^
           (gamma0xh >>> 7);
        var gamma0l =
          ((gamma0xh << 31) | (gamma0xl >>> 1)) ^
          ((gamma0xh << 24) | (gamma0xl >>> 8)) ^
          ((gamma0xh << 25) | (gamma0xl >>> 7));

        // Gamma1
        var gamma1xh = w[(i-2) * 2];
        var gamma1xl = w[(i-2) * 2 + 1];
        var gamma1h =
          ((gamma1xl << 13) | (gamma1xh >>> 19)) ^
          ((gamma1xh << 3)  | (gamma1xl >>> 29)) ^
           (gamma1xh >>> 6);
        var gamma1l =
          ((gamma1xh << 13) | (gamma1xl >>> 19)) ^
          ((gamma1xl << 3)  | (gamma1xh >>> 29)) ^
          ((gamma1xh << 26) | (gamma1xl >>> 6));

        // Shortcuts
        var wr7h = w[(i-7) * 2];
        var wr7l = w[(i-7) * 2 + 1];

        var wr16h = w[(i-16) * 2];
        var wr16l = w[(i-16) * 2 + 1];

        // W(round) = gamma0 + W(round - 7) + gamma1 + W(round - 16)
        wrl = gamma0l + wr7l;
        wrh = gamma0h + wr7h + ((wrl >>> 0) < (gamma0l >>> 0) ? 1 : 0);
        wrl += gamma1l;
        wrh += gamma1h + ((wrl >>> 0) < (gamma1l >>> 0) ? 1 : 0);
        wrl += wr16l;
        wrh += wr16h + ((wrl >>> 0) < (wr16l >>> 0) ? 1 : 0);
      }

      w[i*2] = wrh |= 0;
      w[i*2 + 1] = wrl |= 0;

      // Ch
      var chh = (eh & fh) ^ (~eh & gh);
      var chl = (el & fl) ^ (~el & gl);

      // Maj
      var majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      var majl = (al & bl) ^ (al & cl) ^ (bl & cl);

      // Sigma0
      var sigma0h = ((al << 4) | (ah >>> 28)) ^ ((ah << 30) | (al >>> 2)) ^ ((ah << 25) | (al >>> 7));
      var sigma0l = ((ah << 4) | (al >>> 28)) ^ ((al << 30) | (ah >>> 2)) ^ ((al << 25) | (ah >>> 7));

      // Sigma1
      var sigma1h = ((el << 18) | (eh >>> 14)) ^ ((el << 14) | (eh >>> 18)) ^ ((eh << 23) | (el >>> 9));
      var sigma1l = ((eh << 18) | (el >>> 14)) ^ ((eh << 14) | (el >>> 18)) ^ ((el << 23) | (eh >>> 9));

      // K(round)
      var krh = k[i*2];
      var krl = k[i*2+1];

      // t1 = h + sigma1 + ch + K(round) + W(round)
      var t1l = hl + sigma1l;
      var t1h = hh + sigma1h + ((t1l >>> 0) < (hl >>> 0) ? 1 : 0);
      t1l += chl;
      t1h += chh + ((t1l >>> 0) < (chl >>> 0) ? 1 : 0);
      t1l += krl;
      t1h += krh + ((t1l >>> 0) < (krl >>> 0) ? 1 : 0);
      t1l += wrl;
      t1h += wrh + ((t1l >>> 0) < (wrl >>> 0) ? 1 : 0);

      // t2 = sigma0 + maj
      var t2l = sigma0l + majl;
      var t2h = sigma0h + majh + ((t2l >>> 0) < (sigma0l >>> 0) ? 1 : 0);

      // Update working variables
      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      el = (dl + t1l) | 0;
      eh = (dh + t1h + ((el >>> 0) < (dl >>> 0) ? 1 : 0)) | 0;
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      al = (t1l + t2l) | 0;
      ah = (t1h + t2h + ((al >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0;
    }

    // Intermediate hash
    h0l = h[1] = (h0l + al) | 0;
    h[0] = (h0h + ah + ((h0l >>> 0) < (al >>> 0) ? 1 : 0)) | 0;
    h1l = h[3] = (h1l + bl) | 0;
    h[2] = (h1h + bh + ((h1l >>> 0) < (bl >>> 0) ? 1 : 0)) | 0;
    h2l = h[5] = (h2l + cl) | 0;
    h[4] = (h2h + ch + ((h2l >>> 0) < (cl >>> 0) ? 1 : 0)) | 0;
    h3l = h[7] = (h3l + dl) | 0;
    h[6] = (h3h + dh + ((h3l >>> 0) < (dl >>> 0) ? 1 : 0)) | 0;
    h4l = h[9] = (h4l + el) | 0;
    h[8] = (h4h + eh + ((h4l >>> 0) < (el >>> 0) ? 1 : 0)) | 0;
    h5l = h[11] = (h5l + fl) | 0;
    h[10] = (h5h + fh + ((h5l >>> 0) < (fl >>> 0) ? 1 : 0)) | 0;
    h6l = h[13] = (h6l + gl) | 0;
    h[12] = (h6h + gh + ((h6l >>> 0) < (gl >>> 0) ? 1 : 0)) | 0;
    h7l = h[15] = (h7l + hl) | 0;
    h[14] = (h7h + hh + ((h7l >>> 0) < (hl >>> 0) ? 1 : 0)) | 0;
  }
};


/** @fileOverview Javascript SHA-1 implementation.
 *
 * Based on the implementation in RFC 3174, method 1, and on the SJCL
 * SHA-256 implementation.
 *
 * @author Quinn Slack
 */

/**
 * Context for a SHA-1 operation in progress.
 * @constructor
 * @class Secure Hash Algorithm, 160 bits.
 */
sjcl.hash.sha1 = function (hash) {
  if (hash) {
    this._h = hash._h.slice(0);
    this._buffer = hash._buffer.slice(0);
    this._length = hash._length;
  } else {
    this.reset();
  }
};

/**
 * Hash a string or an array of words.
 * @static
 * @param {bitArray|String} data the data to hash.
 * @return {bitArray} The hash value, an array of 5 big-endian words.
 */
sjcl.hash.sha1.hash = function (data) {
  return (new sjcl.hash.sha1()).update(data).finalize();
};

sjcl.hash.sha1.prototype = {
  /**
   * The hash's block size, in bits.
   * @constant
   */
  blockSize: 512,
   
  /**
   * Reset the hash state.
   * @return this
   */
  reset:function () {
    this._h = this._init.slice(0);
    this._buffer = [];
    this._length = 0;
    return this;
  },
  
  /**
   * Input several words to the hash.
   * @param {bitArray|String} data the data to hash.
   * @return this
   */
  update: function (data) {
    if (typeof data === "string") {
      data = sjcl.codec.utf8String.toBits(data);
    }
    var i, b = this._buffer = sjcl.bitArray.concat(this._buffer, data),
        ol = this._length,
        nl = this._length = ol + sjcl.bitArray.bitLength(data);
    for (i = this.blockSize+ol & -this.blockSize; i <= nl;
         i+= this.blockSize) {
      this._block(b.splice(0,16));
    }
    return this;
  },
  
  /**
   * Complete hashing and output the hash value.
   * @return {bitArray} The hash value, an array of 5 big-endian words. TODO
   */
  finalize:function () {
    var i, b = this._buffer, h = this._h;

    // Round out and push the buffer
    b = sjcl.bitArray.concat(b, [sjcl.bitArray.partial(1,1)]);
    // Round out the buffer to a multiple of 16 words, less the 2 length words.
    for (i = b.length + 2; i & 15; i++) {
      b.push(0);
    }

    // append the length
    b.push(Math.floor(this._length / 0x100000000));
    b.push(this._length | 0);

    while (b.length) {
      this._block(b.splice(0,16));
    }

    this.reset();
    return h;
  },

  /**
   * The SHA-1 initialization vector.
   * @private
   */
  _init:[0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],

  /**
   * The SHA-1 hash key.
   * @private
   */
  _key:[0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6],

  /**
   * The SHA-1 logical functions f(0), f(1), ..., f(79).
   * @private
   */
  _f:function(t, b, c, d) {
    if (t <= 19) {
      return (b & c) | (~b & d);
    } else if (t <= 39) {
      return b ^ c ^ d;
    } else if (t <= 59) {
      return (b & c) | (b & d) | (c & d);
    } else if (t <= 79) {
      return b ^ c ^ d;
    }
  },

  /**
   * Circular left-shift operator.
   * @private
   */
  _S:function(n, x) {
    return (x << n) | (x >>> 32-n);
  },
  
  /**
   * Perform one cycle of SHA-1.
   * @param {bitArray} words one block of words.
   * @private
   */
  _block:function (words) {  
    var t, tmp, a, b, c, d, e,
    w = words.slice(0),
    h = this._h,
    k = this._key;
   
    a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4]; 

    for (t=0; t<=79; t++) {
      if (t >= 16) {
        w[t] = this._S(1, w[t-3] ^ w[t-8] ^ w[t-14] ^ w[t-16]);
      }
      tmp = (this._S(5, a) + this._f(t, b, c, d) + e + w[t] +
             this._key[Math.floor(t/20)]) | 0;
      e = d;
      d = c;
      c = this._S(30, b);
      b = a;
      a = tmp;
   }

   h[0] = (h[0]+a) |0;
   h[1] = (h[1]+b) |0;
   h[2] = (h[2]+c) |0;
   h[3] = (h[3]+d) |0;
   h[4] = (h[4]+e) |0;
  }
};
/** @fileOverview CCM mode implementation.
 *
 * Special thanks to Roy Nicholson for pointing out a bug in our
 * implementation.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace CTR mode with CBC MAC. */
sjcl.mode.ccm = {
  /** The name of the mode.
   * @constant
   */
  name: "ccm",
  
  /** Encrypt in CCM mode.
   * @static
   * @param {Object} prf The pseudorandom function.  It must have a block size of 16 bytes.
   * @param {bitArray} plaintext The plaintext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [adata=[]] The authenticated data.
   * @param {Number} [tlen=64] the desired tag length, in bits.
   * @return {bitArray} The encrypted data, an array of bytes.
   */
  encrypt: function(prf, plaintext, iv, adata, tlen) {
    var L, i, out = plaintext.slice(0), tag, w=sjcl.bitArray, ivl = w.bitLength(iv) / 8, ol = w.bitLength(out) / 8;
    tlen = tlen || 64;
    adata = adata || [];
    
    if (ivl < 7) {
      throw new sjcl.exception.invalid("ccm: iv must be at least 7 bytes");
    }
    
    // compute the length of the length
    for (L=2; L<4 && ol >>> 8*L; L++) {}
    if (L < 15 - ivl) { L = 15-ivl; }
    iv = w.clamp(iv,8*(15-L));
    
    // compute the tag
    tag = sjcl.mode.ccm._computeTag(prf, plaintext, iv, adata, tlen, L);
    
    // encrypt
    out = sjcl.mode.ccm._ctrMode(prf, out, iv, tag, tlen, L);
    
    return w.concat(out.data, out.tag);
  },
  
  /** Decrypt in CCM mode.
   * @static
   * @param {Object} prf The pseudorandom function.  It must have a block size of 16 bytes.
   * @param {bitArray} ciphertext The ciphertext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [[]] adata The authenticated data.
   * @param {Number} [64] tlen the desired tag length, in bits.
   * @return {bitArray} The decrypted data.
   */
  decrypt: function(prf, ciphertext, iv, adata, tlen) {
    tlen = tlen || 64;
    adata = adata || [];
    var L, i, 
        w=sjcl.bitArray,
        ivl = w.bitLength(iv) / 8,
        ol = w.bitLength(ciphertext), 
        out = w.clamp(ciphertext, ol - tlen),
        tag = w.bitSlice(ciphertext, ol - tlen), tag2;
    

    ol = (ol - tlen) / 8;
        
    if (ivl < 7) {
      throw new sjcl.exception.invalid("ccm: iv must be at least 7 bytes");
    }
    
    // compute the length of the length
    for (L=2; L<4 && ol >>> 8*L; L++) {}
    if (L < 15 - ivl) { L = 15-ivl; }
    iv = w.clamp(iv,8*(15-L));
    
    // decrypt
    out = sjcl.mode.ccm._ctrMode(prf, out, iv, tag, tlen, L);
    
    // check the tag
    tag2 = sjcl.mode.ccm._computeTag(prf, out.data, iv, adata, tlen, L);
    if (!w.equal(out.tag, tag2)) {
      throw new sjcl.exception.corrupt("ccm: tag doesn't match");
    }
    
    return out.data;
  },

  /* Compute the (unencrypted) authentication tag, according to the CCM specification
   * @param {Object} prf The pseudorandom function.
   * @param {bitArray} plaintext The plaintext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} adata The authenticated data.
   * @param {Number} tlen the desired tag length, in bits.
   * @return {bitArray} The tag, but not yet encrypted.
   * @private
   */
  _computeTag: function(prf, plaintext, iv, adata, tlen, L) {
    // compute B[0]
    var q, mac, field = 0, offset = 24, tmp, i, macData = [], w=sjcl.bitArray, xor = w._xor4;

    tlen /= 8;
  
    // check tag length and message length
    if (tlen % 2 || tlen < 4 || tlen > 16) {
      throw new sjcl.exception.invalid("ccm: invalid tag length");
    }
  
    if (adata.length > 0xFFFFFFFF || plaintext.length > 0xFFFFFFFF) {
      // I don't want to deal with extracting high words from doubles.
      throw new sjcl.exception.bug("ccm: can't deal with 4GiB or more data");
    }

    // mac the flags
    mac = [w.partial(8, (adata.length ? 1<<6 : 0) | (tlen-2) << 2 | L-1)];

    // mac the iv and length
    mac = w.concat(mac, iv);
    mac[3] |= w.bitLength(plaintext)/8;
    mac = prf.encrypt(mac);
    
  
    if (adata.length) {
      // mac the associated data.  start with its length...
      tmp = w.bitLength(adata)/8;
      if (tmp <= 0xFEFF) {
        macData = [w.partial(16, tmp)];
      } else if (tmp <= 0xFFFFFFFF) {
        macData = w.concat([w.partial(16,0xFFFE)], [tmp]);
      } // else ...
    
      // mac the data itself
      macData = w.concat(macData, adata);
      for (i=0; i<macData.length; i += 4) {
        mac = prf.encrypt(xor(mac, macData.slice(i,i+4).concat([0,0,0])));
      }
    }
  
    // mac the plaintext
    for (i=0; i<plaintext.length; i+=4) {
      mac = prf.encrypt(xor(mac, plaintext.slice(i,i+4).concat([0,0,0])));
    }

    return w.clamp(mac, tlen * 8);
  },

  /** CCM CTR mode.
   * Encrypt or decrypt data and tag with the prf in CCM-style CTR mode.
   * May mutate its arguments.
   * @param {Object} prf The PRF.
   * @param {bitArray} data The data to be encrypted or decrypted.
   * @param {bitArray} iv The initialization vector.
   * @param {bitArray} tag The authentication tag.
   * @param {Number} tlen The length of th etag, in bits.
   * @param {Number} L The CCM L value.
   * @return {Object} An object with data and tag, the en/decryption of data and tag values.
   * @private
   */
  _ctrMode: function(prf, data, iv, tag, tlen, L) {
    var enc, i, w=sjcl.bitArray, xor = w._xor4, ctr, b, l = data.length, bl=w.bitLength(data);

    // start the ctr
    ctr = w.concat([w.partial(8,L-1)],iv).concat([0,0,0]).slice(0,4);
    
    // en/decrypt the tag
    tag = w.bitSlice(xor(tag,prf.encrypt(ctr)), 0, tlen);
  
    // en/decrypt the data
    if (!l) { return {tag:tag, data:[]}; }
    
    for (i=0; i<l; i+=4) {
      ctr[3]++;
      enc = prf.encrypt(ctr);
      data[i]   ^= enc[0];
      data[i+1] ^= enc[1];
      data[i+2] ^= enc[2];
      data[i+3] ^= enc[3];
    }
    return { tag:tag, data:w.clamp(data,bl) };
  }
};
/** @fileOverview CBC mode implementation
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

if (sjcl.beware === undefined) {
  sjcl.beware = {};
}
sjcl.beware["CBC mode is dangerous because it doesn't protect message integrity."
] = function() {
  /** @namespace
   * Dangerous: CBC mode with PKCS#5 padding.
   *
   * @author Emily Stark
   * @author Mike Hamburg
   * @author Dan Boneh
   */
  sjcl.mode.cbc = {
    /** The name of the mode.
     * @constant
     */
    name: "cbc",
    
    /** Encrypt in CBC mode with PKCS#5 padding.
     * @param {Object} prp The block cipher.  It must have a block size of 16 bytes.
     * @param {bitArray} plaintext The plaintext data.
     * @param {bitArray} iv The initialization value.
     * @param {bitArray} [adata=[]] The authenticated data.  Must be empty.
     * @return The encrypted data, an array of bytes.
     * @throws {sjcl.exception.invalid} if the IV isn't exactly 128 bits, or if any adata is specified.
     */
    encrypt: function(prp, plaintext, iv, adata, options) {
      if (adata && adata.length) {
        throw new sjcl.exception.invalid("cbc can't authenticate data");
      }
      if (sjcl.bitArray.bitLength(iv) !== 128) {
        throw new sjcl.exception.invalid("cbc iv must be 128 bits");
      }
      var i,
          w = sjcl.bitArray,
          xor = w._xor4,
          bl = w.bitLength(plaintext),
          bp = 0,
          output = [];

      if (bl&7) {
        throw new sjcl.exception.invalid("pkcs#5 padding only works for multiples of a byte");
      }
    
      for (i=0; bp+128 <= bl; i+=4, bp+=128) {
        /* Encrypt a non-final block */
        iv = prp.encrypt(xor(iv, plaintext.slice(i,i+4)));
        output.splice(i,0,iv[0],iv[1],iv[2],iv[3]);
      }
      
      /* Construct the pad. */
      bl = (16 - ((bl >> 3) & 15)) * 0x1010101;

	  // AL - add option for AsciiX923 padding
	  var padded = w.concat(plaintext,[bl,bl,bl,bl]).slice(i,i+4);
	  if((options || {}).ascii)
	  {
		  // convert PKCS padding to AsciiX923
		  var bytes = sjcl.codec.bytes.fromBits(padded);
		  var padv = bytes[bytes.length - 1];
		  for(var ip = 0; ip < padv - 1; ip++)
		  {
			  bytes[(bytes.length - padv) + ip] = 0;
		  }
		  padded = sjcl.codec.bytes.toBits(bytes);
	  }
      /* Pad and encrypt. */
      iv = prp.encrypt(xor(iv,padded));
      //iv = prp.encrypt(xor(iv,w.concat(plaintext,[bl,bl,bl,bl]).slice(i,i+4)));
      output.splice(i,0,iv[0],iv[1],iv[2],iv[3]);
      return output;
    },
    
    /** Decrypt in CBC mode.
     * @param {Object} prp The block cipher.  It must have a block size of 16 bytes.
     * @param {bitArray} ciphertext The ciphertext data.
     * @param {bitArray} iv The initialization value.
     * @param {bitArray} [adata=[]] The authenticated data.  It must be empty.
     * @return The decrypted data, an array of bytes.
     * @throws {sjcl.exception.invalid} if the IV isn't exactly 128 bits, or if any adata is specified.
     * @throws {sjcl.exception.corrupt} if if the message is corrupt.
     */
    decrypt: function(prp, ciphertext, iv, adata) {
      if (adata && adata.length) {
        throw new sjcl.exception.invalid("cbc can't authenticate data");
      }
      if (sjcl.bitArray.bitLength(iv) !== 128) {
        throw new sjcl.exception.invalid("cbc iv must be 128 bits");
      }
      if ((sjcl.bitArray.bitLength(ciphertext) & 127) || !ciphertext.length) {
        throw new sjcl.exception.corrupt("cbc ciphertext must be a positive multiple of the block size");
      }
      var i,
          w = sjcl.bitArray,
          xor = w._xor4,
          bi, bo,
          output = [];
          
      adata = adata || [];
    
      for (i=0; i<ciphertext.length; i+=4) {
        bi = ciphertext.slice(i,i+4);
        bo = xor(iv,prp.decrypt(bi));
        output.splice(i,0,bo[0],bo[1],bo[2],bo[3]);
        iv = bi;
      }

      /* check and remove the pad */
      bi = output[i-1] & 255;
      if (bi === 0 || bi > 16) {
        throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
      }
      bo = bi * 0x1010101;
      if (!w.equal(w.bitSlice([bo,bo,bo,bo], 0, bi*8),
                   w.bitSlice(output, output.length*32 - bi*8, output.length*32))) {
        // AL - disable check since it prevents us from decrypting AsciiX923
        // padding, and we only use CBC for legacy data, so no harm done.
        //throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
      }

      return w.bitSlice(output, 0, output.length*32 - bi*8);
    }
  };
};
/** @fileOverview OCB 2.0 implementation
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** @namespace
 * Phil Rogaway's Offset CodeBook mode, version 2.0.
 * May be covered by US and international patents.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */
sjcl.mode.ocb2 = {
  /** The name of the mode.
   * @constant
   */
  name: "ocb2",
  
  /** Encrypt in OCB mode, version 2.0.
   * @param {Object} prp The block cipher.  It must have a block size of 16 bytes.
   * @param {bitArray} plaintext The plaintext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [adata=[]] The authenticated data.
   * @param {Number} [tlen=64] the desired tag length, in bits.
   * @param [false] premac 1 if the authentication data is pre-macced with PMAC.
   * @return The encrypted data, an array of bytes.
   * @throws {sjcl.exception.invalid} if the IV isn't exactly 128 bits.
   */
  encrypt: function(prp, plaintext, iv, adata, tlen, premac) {
    if (sjcl.bitArray.bitLength(iv) !== 128) {
      throw new sjcl.exception.invalid("ocb iv must be 128 bits");
    }
    var i,
        times2 = sjcl.mode.ocb2._times2,
        w = sjcl.bitArray,
        xor = w._xor4,
        checksum = [0,0,0,0],
        delta = times2(prp.encrypt(iv)),
        bi, bl,
        output = [],
        pad;
        
    adata = adata || [];
    tlen = tlen || 64;
  
    for (i=0; i+4 < plaintext.length; i+=4) {
      /* Encrypt a non-final block */
      bi = plaintext.slice(i,i+4);
      checksum = xor(checksum, bi);
      output = output.concat(xor(delta,prp.encrypt(xor(delta, bi))));
      delta = times2(delta);
    }
    
    /* Chop out the final block */
    bi = plaintext.slice(i);
    bl = w.bitLength(bi);
    pad = prp.encrypt(xor(delta,[0,0,0,bl]));
    bi = w.clamp(xor(bi.concat([0,0,0]),pad), bl);
    
    /* Checksum the final block, and finalize the checksum */
    checksum = xor(checksum,xor(bi.concat([0,0,0]),pad));
    checksum = prp.encrypt(xor(checksum,xor(delta,times2(delta))));
    
    /* MAC the header */
    if (adata.length) {
      checksum = xor(checksum, premac ? adata : sjcl.mode.ocb2.pmac(prp, adata));
    }
    
    return output.concat(w.concat(bi, w.clamp(checksum, tlen)));
  },
  
  /** Decrypt in OCB mode.
   * @param {Object} prp The block cipher.  It must have a block size of 16 bytes.
   * @param {bitArray} ciphertext The ciphertext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [adata=[]] The authenticated data.
   * @param {Number} [tlen=64] the desired tag length, in bits.
   * @param {boolean} [premac=false] true if the authentication data is pre-macced with PMAC.
   * @return The decrypted data, an array of bytes.
   * @throws {sjcl.exception.invalid} if the IV isn't exactly 128 bits.
   * @throws {sjcl.exception.corrupt} if if the message is corrupt.
   */
  decrypt: function(prp, ciphertext, iv, adata, tlen, premac) {
    if (sjcl.bitArray.bitLength(iv) !== 128) {
      throw new sjcl.exception.invalid("ocb iv must be 128 bits");
    }
    tlen = tlen || 64;
    var i,
        times2 = sjcl.mode.ocb2._times2,
        w = sjcl.bitArray,
        xor = w._xor4,
        checksum = [0,0,0,0],
        delta = times2(prp.encrypt(iv)),
        bi, bl,
        len = sjcl.bitArray.bitLength(ciphertext) - tlen,
        output = [],
        pad;
        
    adata = adata || [];
  
    for (i=0; i+4 < len/32; i+=4) {
      /* Decrypt a non-final block */
      bi = xor(delta, prp.decrypt(xor(delta, ciphertext.slice(i,i+4))));
      checksum = xor(checksum, bi);
      output = output.concat(bi);
      delta = times2(delta);
    }
    
    /* Chop out and decrypt the final block */
    bl = len-i*32;
    pad = prp.encrypt(xor(delta,[0,0,0,bl]));
    bi = xor(pad, w.clamp(ciphertext.slice(i),bl).concat([0,0,0]));
    
    /* Checksum the final block, and finalize the checksum */
    checksum = xor(checksum, bi);
    checksum = prp.encrypt(xor(checksum, xor(delta, times2(delta))));
    
    /* MAC the header */
    if (adata.length) {
      checksum = xor(checksum, premac ? adata : sjcl.mode.ocb2.pmac(prp, adata));
    }
    
    if (!w.equal(w.clamp(checksum, tlen), w.bitSlice(ciphertext, len))) {
      throw new sjcl.exception.corrupt("ocb: tag doesn't match");
    }
    
    return output.concat(w.clamp(bi,bl));
  },
  
  /** PMAC authentication for OCB associated data.
   * @param {Object} prp The block cipher.  It must have a block size of 16 bytes.
   * @param {bitArray} adata The authenticated data.
   */
  pmac: function(prp, adata) {
    var i,
        times2 = sjcl.mode.ocb2._times2,
        w = sjcl.bitArray,
        xor = w._xor4,
        checksum = [0,0,0,0],
        delta = prp.encrypt([0,0,0,0]),
        bi;
        
    delta = xor(delta,times2(times2(delta)));
 
    for (i=0; i+4<adata.length; i+=4) {
      delta = times2(delta);
      checksum = xor(checksum, prp.encrypt(xor(delta, adata.slice(i,i+4))));
    }
    
    bi = adata.slice(i);
    if (w.bitLength(bi) < 128) {
      delta = xor(delta,times2(delta));
      bi = w.concat(bi,[0x80000000|0,0,0,0]);
    }
    checksum = xor(checksum, bi);
    return prp.encrypt(xor(times2(xor(delta,times2(delta))), checksum));
  },
  
  /** Double a block of words, OCB style.
   * @private
   */
  _times2: function(x) {
    return [x[0]<<1 ^ x[1]>>>31,
            x[1]<<1 ^ x[2]>>>31,
            x[2]<<1 ^ x[3]>>>31,
            x[3]<<1 ^ (x[0]>>>31)*0x87];
  }
};
/** @fileOverview GCM mode implementation.
 *
 * @author Juho V??h??-Herttua
 */

/** @namespace Galois/Counter mode. */
sjcl.mode.gcm = {
  /** The name of the mode.
   * @constant
   */
  name: "gcm",
  
  /** Encrypt in GCM mode.
   * @static
   * @param {Object} prf The pseudorandom function.  It must have a block size of 16 bytes.
   * @param {bitArray} plaintext The plaintext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [adata=[]] The authenticated data.
   * @param {Number} [tlen=128] The desired tag length, in bits.
   * @return {bitArray} The encrypted data, an array of bytes.
   */
  encrypt: function (prf, plaintext, iv, adata, tlen) {
    var out, data = plaintext.slice(0), w=sjcl.bitArray;
    tlen = tlen || 128;
    adata = adata || [];

    // encrypt and tag
    out = sjcl.mode.gcm._ctrMode(true, prf, data, adata, iv, tlen);

    return w.concat(out.data, out.tag);
  },
  
  /** Decrypt in GCM mode.
   * @static
   * @param {Object} prf The pseudorandom function.  It must have a block size of 16 bytes.
   * @param {bitArray} ciphertext The ciphertext data.
   * @param {bitArray} iv The initialization value.
   * @param {bitArray} [adata=[]] The authenticated data.
   * @param {Number} [tlen=128] The desired tag length, in bits.
   * @return {bitArray} The decrypted data.
   */
  decrypt: function (prf, ciphertext, iv, adata, tlen) {
    var out, data = ciphertext.slice(0), tag, w=sjcl.bitArray, l=w.bitLength(data);
    tlen = tlen || 128;
    adata = adata || [];

    // Slice tag out of data
    if (tlen <= l) {
      tag = w.bitSlice(data, l-tlen);
      data = w.bitSlice(data, 0, l-tlen);
    } else {
      tag = data;
      data = [];
    }

    // decrypt and tag
    out = sjcl.mode.gcm._ctrMode(false, prf, data, adata, iv, tlen);

    if (!w.equal(out.tag, tag)) {
      throw new sjcl.exception.corrupt("gcm: tag doesn't match");
    }
    return out.data;
  },

  /* Compute the galois multiplication of X and Y
   * @private
   */
  _galoisMultiply: function (x, y) {
    var i, j, xi, Zi, Vi, lsb_Vi, w=sjcl.bitArray, xor=w._xor4;

    Zi = [0,0,0,0];
    Vi = y.slice(0);

    // Block size is 128 bits, run 128 times to get Z_128
    for (i=0; i<128; i++) {
      xi = (x[Math.floor(i/32)] & (1 << (31-i%32))) !== 0;
      if (xi) {
        // Z_i+1 = Z_i ^ V_i
        Zi = xor(Zi, Vi);
      }

      // Store the value of LSB(V_i)
      lsb_Vi = (Vi[3] & 1) !== 0;

      // V_i+1 = V_i >> 1
      for (j=3; j>0; j--) {
        Vi[j] = (Vi[j] >>> 1) | ((Vi[j-1]&1) << 31);
      }
      Vi[0] = Vi[0] >>> 1;

      // If LSB(V_i) is 1, V_i+1 = (V_i >> 1) ^ R
      if (lsb_Vi) {
        Vi[0] = Vi[0] ^ (0xe1 << 24);
      }
    }
    return Zi;
  },

  _ghash: function(H, Y0, data) {
    var Yi, i, l = data.length;

    Yi = Y0.slice(0);
    for (i=0; i<l; i+=4) {
      Yi[0] ^= 0xffffffff&data[i];
      Yi[1] ^= 0xffffffff&data[i+1];
      Yi[2] ^= 0xffffffff&data[i+2];
      Yi[3] ^= 0xffffffff&data[i+3];
      Yi = sjcl.mode.gcm._galoisMultiply(Yi, H);
    }
    return Yi;
  },

  /** GCM CTR mode.
   * Encrypt or decrypt data and tag with the prf in GCM-style CTR mode.
   * @param {Boolean} encrypt True if encrypt, false if decrypt.
   * @param {Object} prf The PRF.
   * @param {bitArray} data The data to be encrypted or decrypted.
   * @param {bitArray} iv The initialization vector.
   * @param {bitArray} adata The associated data to be tagged.
   * @param {Number} tlen The length of the tag, in bits.
   */
  _ctrMode: function(encrypt, prf, data, adata, iv, tlen) {
    var H, J0, S0, enc, i, ctr, tag, last, l, bl, abl, ivbl, w=sjcl.bitArray, xor=w._xor4;

    // Calculate data lengths
    l = data.length;
    bl = w.bitLength(data);
    abl = w.bitLength(adata);
    ivbl = w.bitLength(iv);

    // Calculate the parameters
    H = prf.encrypt([0,0,0,0]);
    if (ivbl === 96) {
      J0 = iv.slice(0);
      J0 = w.concat(J0, [1]);
    } else {
      J0 = sjcl.mode.gcm._ghash(H, [0,0,0,0], iv);
      J0 = sjcl.mode.gcm._ghash(H, J0, [0,0,Math.floor(ivbl/0x100000000),ivbl&0xffffffff]);
    }
    S0 = sjcl.mode.gcm._ghash(H, [0,0,0,0], adata);

    // Initialize ctr and tag
    ctr = J0.slice(0);
    tag = S0.slice(0);

    // If decrypting, calculate hash
    if (!encrypt) {
      tag = sjcl.mode.gcm._ghash(H, S0, data);
    }

    // Encrypt all the data
    for (i=0; i<l; i+=4) {
       ctr[3]++;
       enc = prf.encrypt(ctr);
       data[i]   ^= enc[0];
       data[i+1] ^= enc[1];
       data[i+2] ^= enc[2];
       data[i+3] ^= enc[3];
    }
    data = w.clamp(data, bl);

    // If encrypting, calculate hash
    if (encrypt) {
      tag = sjcl.mode.gcm._ghash(H, S0, data);
    }

    // Calculate last block from bit lengths, ugly because bitwise operations are 32-bit
    last = [
      Math.floor(abl/0x100000000), abl&0xffffffff,
      Math.floor(bl/0x100000000), bl&0xffffffff
    ];

    // Calculate the final tag block
    tag = sjcl.mode.gcm._ghash(H, tag, last);
    enc = prf.encrypt(J0);
    tag[0] ^= enc[0];
    tag[1] ^= enc[1];
    tag[2] ^= enc[2];
    tag[3] ^= enc[3];

    return { tag:w.bitSlice(tag, 0, tlen), data:data };
  }
};
/** @fileOverview HMAC implementation.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** HMAC with the specified hash function.
 * @constructor
 * @param {bitArray} key the key for HMAC.
 * @param {Object} [hash=sjcl.hash.sha256] The hash function to use.
 */
sjcl.misc.hmac = function (key, Hash) {
  this._hash = Hash = Hash || sjcl.hash.sha256;
  var exKey = [[],[]], i,
      bs = Hash.prototype.blockSize / 32;
  this._baseHash = [new Hash(), new Hash()];

  if (key.length > bs) {
    key = Hash.hash(key);
  }
  
  for (i=0; i<bs; i++) {
    exKey[0][i] = key[i]^0x36363636;
    exKey[1][i] = key[i]^0x5C5C5C5C;
  }
  
  this._baseHash[0].update(exKey[0]);
  this._baseHash[1].update(exKey[1]);
  this._resultHash = new Hash(this._baseHash[0]);
};

/** HMAC with the specified hash function.  Also called encrypt since it's a prf.
 * @param {bitArray|String} data The data to mac.
 */
sjcl.misc.hmac.prototype.encrypt = sjcl.misc.hmac.prototype.mac = function (data) {
  if (!this._updated) {
    this.update(data);
    return this.digest(data);
  } else {
    throw new sjcl.exception.invalid("encrypt on already updated hmac called!");
  }
};

sjcl.misc.hmac.prototype.reset = function () {
  this._resultHash = new this._hash(this._baseHash[0]);
  this._updated = false;
};

sjcl.misc.hmac.prototype.update = function (data) {
  this._updated = true;
  this._resultHash.update(data);
};

sjcl.misc.hmac.prototype.digest = function () {
  var w = this._resultHash.finalize(), result = new (this._hash)(this._baseHash[1]).update(w).finalize();

  this.reset();

  return result;
};/** @fileOverview Password-based key-derivation function, version 2.0.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 */

/** Password-Based Key-Derivation Function, version 2.0.
 *
 * Generate keys from passwords using PBKDF2-HMAC-SHA256.
 *
 * This is the method specified by RSA's PKCS #5 standard.
 *
 * @param {bitArray|String} password  The password.
 * @param {bitArray|String} salt The salt.  Should have lots of entropy.
 * @param {Number} [count=1000] The number of iterations.  Higher numbers make the function slower but more secure.
 * @param {Number} [length] The length of the derived key.  Defaults to the
                            output size of the hash function.
 * @param {Object} [Prff=sjcl.misc.hmac] The pseudorandom function family.
 * @return {bitArray} the derived key.
 */
sjcl.misc.pbkdf2 = function (password, salt, count, length, Prff) {
  count = count || 1000;
  
  if (length < 0 || count < 0) {
    throw sjcl.exception.invalid("invalid params to pbkdf2");
  }
  
  if (typeof password === "string") {
    password = sjcl.codec.utf8String.toBits(password);
  }
  
  if (typeof salt === "string") {
    salt = sjcl.codec.utf8String.toBits(salt);
  }
  
  Prff = Prff || sjcl.misc.hmac;
  
  var prf = new Prff(password),
      u, ui, i, j, k, out = [], b = sjcl.bitArray;

  for (k = 1; 32 * out.length < (length || 1); k++) {
    u = ui = prf.encrypt(b.concat(salt,[k]));
    
    for (i=1; i<count; i++) {
      ui = prf.encrypt(ui);
      for (j=0; j<ui.length; j++) {
        u[j] ^= ui[j];
      }
    }
    
    out = out.concat(u);
  }

  if (length) { out = b.clamp(out, length); }

  return out;
};
/** @fileOverview Random number generator.
 *
 * @author Emily Stark
 * @author Mike Hamburg
 * @author Dan Boneh
 * @author Michael Brooks
 */

/** @constructor
 * @class Random number generator
 * @description
 * <b>Use sjcl.random as a singleton for this class!</b>
 * <p>
 * This random number generator is a derivative of Ferguson and Schneier's
 * generator Fortuna.  It collects entropy from various events into several
 * pools, implemented by streaming SHA-256 instances.  It differs from
 * ordinary Fortuna in a few ways, though.
 * </p>
 *
 * <p>
 * Most importantly, it has an entropy estimator.  This is present because
 * there is a strong conflict here between making the generator available
 * as soon as possible, and making sure that it doesn't "run on empty".
 * In Fortuna, there is a saved state file, and the system is likely to have
 * time to warm up.
 * </p>
 *
 * <p>
 * Second, because users are unlikely to stay on the page for very long,
 * and to speed startup time, the number of pools increases logarithmically:
 * a new pool is created when the previous one is actually used for a reseed.
 * This gives the same asymptotic guarantees as Fortuna, but gives more
 * entropy to early reseeds.
 * </p>
 *
 * <p>
 * The entire mechanism here feels pretty klunky.  Furthermore, there are
 * several improvements that should be made, including support for
 * dedicated cryptographic functions that may be present in some browsers;
 * state files in local storage; cookies containing randomness; etc.  So
 * look for improvements in future versions.
 * </p>
 */
sjcl.prng = function(defaultParanoia) {
  
  /* private */
  this._pools = [new sjcl.hash.sha256()];
  this._poolEntropy = [0];
  this._reseedCount = 0;
  this._robins = {};
  this._eventId = 0;
  
  this._collectorIds = {};
  this._collectorIdNext = 0;
  
  this._strength = 0;
  this._poolStrength = 0;
  this._nextReseed = 0;
  this._key = [0,0,0,0,0,0,0,0];
  this._counter = [0,0,0,0];
  this._cipher = undefined;
  this._defaultParanoia = defaultParanoia;
  
  /* event listener stuff */
  this._collectorsStarted = false;
  this._callbacks = {progress: {}, seeded: {}};
  this._callbackI = 0;
  
  /* constants */
  this._NOT_READY = 0;
  this._READY = 1;
  this._REQUIRES_RESEED = 2;

  this._MAX_WORDS_PER_BURST = 65536;
  this._PARANOIA_LEVELS = [0,48,64,96,128,192,256,384,512,768,1024];
  this._MILLISECONDS_PER_RESEED = 30000;
  this._BITS_PER_RESEED = 80;
};
 
sjcl.prng.prototype = {
  /** Generate several random words, and return them in an array.
   * A word consists of 32 bits (4 bytes)
   * @param {Number} nwords The number of words to generate.
   */
  randomWords: function (nwords, paranoia) {
    var out = [], i, readiness = this.isReady(paranoia), g;
  
    if (readiness === this._NOT_READY) {
      throw new sjcl.exception.notReady("generator isn't seeded");
    } else if (readiness & this._REQUIRES_RESEED) {
      this._reseedFromPools(!(readiness & this._READY));
    }
  
    for (i=0; i<nwords; i+= 4) {
      if ((i+1) % this._MAX_WORDS_PER_BURST === 0) {
        this._gate();
      }
   
      g = this._gen4words();
      out.push(g[0],g[1],g[2],g[3]);
    }
    this._gate();
  
    return out.slice(0,nwords);
  },
  
  setDefaultParanoia: function (paranoia, allowZeroParanoia) {
    if (paranoia === 0 && allowZeroParanoia !== "Setting paranoia=0 will ruin your security; use it only for testing") {
      throw "Setting paranoia=0 will ruin your security; use it only for testing";
    }

    this._defaultParanoia = paranoia;
  },
  
  /**
   * Add entropy to the pools.
   * @param data The entropic value.  Should be a 32-bit integer, array of 32-bit integers, or string
   * @param {Number} estimatedEntropy The estimated entropy of data, in bits
   * @param {String} source The source of the entropy, eg "mouse"
   */
  addEntropy: function (data, estimatedEntropy, source) {
    source = source || "user";
  
    var id,
      i, tmp,
      t = (new Date()).valueOf(),
      robin = this._robins[source],
      oldReady = this.isReady(), err = 0, objName;
      
    id = this._collectorIds[source];
    if (id === undefined) { id = this._collectorIds[source] = this._collectorIdNext ++; }
      
    if (robin === undefined) { robin = this._robins[source] = 0; }
    this._robins[source] = ( this._robins[source] + 1 ) % this._pools.length;
  
    switch(typeof(data)) {
      
    case "number":
      if (estimatedEntropy === undefined) {
        estimatedEntropy = 1;
      }
      this._pools[robin].update([id,this._eventId++,1,estimatedEntropy,t,1,data|0]);
      break;
      
    case "object":
      objName = Object.prototype.toString.call(data);
      if (objName === "[object Uint32Array]") {
        tmp = [];
        for (i = 0; i < data.length; i++) {
          tmp.push(data[i]);
        }
        data = tmp;
      } else {
        if (objName !== "[object Array]") {
          err = 1;
        }
        for (i=0; i<data.length && !err; i++) {
          if (typeof(data[i]) !== "number") {
            err = 1;
          }
        }
      }
      if (!err) {
        if (estimatedEntropy === undefined) {
          /* horrible entropy estimator */
          estimatedEntropy = 0;
          for (i=0; i<data.length; i++) {
            tmp= data[i];
            while (tmp>0) {
              estimatedEntropy++;
              tmp = tmp >>> 1;
            }
          }
        }
        this._pools[robin].update([id,this._eventId++,2,estimatedEntropy,t,data.length].concat(data));
      }
      break;
      
    case "string":
      if (estimatedEntropy === undefined) {
       /* English text has just over 1 bit per character of entropy.
        * But this might be HTML or something, and have far less
        * entropy than English...  Oh well, let's just say one bit.
        */
       estimatedEntropy = data.length;
      }
      this._pools[robin].update([id,this._eventId++,3,estimatedEntropy,t,data.length]);
      this._pools[robin].update(data);
      break;
      
    default:
      err=1;
    }
    if (err) {
      throw new sjcl.exception.bug("random: addEntropy only supports number, array of numbers or string");
    }
  
    /* record the new strength */
    this._poolEntropy[robin] += estimatedEntropy;
    this._poolStrength += estimatedEntropy;
  
    /* fire off events */
    if (oldReady === this._NOT_READY) {
      if (this.isReady() !== this._NOT_READY) {
        this._fireEvent("seeded", Math.max(this._strength, this._poolStrength));
      }
      this._fireEvent("progress", this.getProgress());
    }
  },
  
  /** Is the generator ready? */
  isReady: function (paranoia) {
    var entropyRequired = this._PARANOIA_LEVELS[ (paranoia !== undefined) ? paranoia : this._defaultParanoia ];
  
    if (this._strength && this._strength >= entropyRequired) {
      return (this._poolEntropy[0] > this._BITS_PER_RESEED && (new Date()).valueOf() > this._nextReseed) ?
        this._REQUIRES_RESEED | this._READY :
        this._READY;
    } else {
      return (this._poolStrength >= entropyRequired) ?
        this._REQUIRES_RESEED | this._NOT_READY :
        this._NOT_READY;
    }
  },
  
  /** Get the generator's progress toward readiness, as a fraction */
  getProgress: function (paranoia) {
    var entropyRequired = this._PARANOIA_LEVELS[ paranoia ? paranoia : this._defaultParanoia ];
  
    if (this._strength >= entropyRequired) {
      return 1.0;
    } else {
      return (this._poolStrength > entropyRequired) ?
        1.0 :
        this._poolStrength / entropyRequired;
    }
  },
  
  /** start the built-in entropy collectors */
  startCollectors: function () {
    if (this._collectorsStarted) { return; }
  
    this._eventListener = {
      loadTimeCollector: this._bind(this._loadTimeCollector),
      mouseCollector: this._bind(this._mouseCollector),
      keyboardCollector: this._bind(this._keyboardCollector),
      accelerometerCollector: this._bind(this._accelerometerCollector)
    }

    if (window.addEventListener) {
      window.addEventListener("load", this._eventListener.loadTimeCollector, false);
      window.addEventListener("mousemove", this._eventListener.mouseCollector, false);
      window.addEventListener("keypress", this._eventListener.keyboardCollector, false);
      window.addEventListener("devicemotion", this._eventListener.accelerometerCollector, false);
    } else if (document.attachEvent) {
      document.attachEvent("onload", this._eventListener.loadTimeCollector);
      document.attachEvent("onmousemove", this._eventListener.mouseCollector);
      document.attachEvent("keypress", this._eventListener.keyboardCollector);
    } else {
      throw new sjcl.exception.bug("can't attach event");
    }
  
    this._collectorsStarted = true;
  },
  
  /** stop the built-in entropy collectors */
  stopCollectors: function () {
    if (!this._collectorsStarted) { return; }
  
    if (window.removeEventListener) {
      window.removeEventListener("load", this._eventListener.loadTimeCollector, false);
      window.removeEventListener("mousemove", this._eventListener.mouseCollector, false);
      window.removeEventListener("keypress", this._eventListener.keyboardCollector, false);
      window.removeEventListener("devicemotion", this._eventListener.accelerometerCollector, false);
    } else if (document.detachEvent) {
      document.detachEvent("onload", this._eventListener.loadTimeCollector);
      document.detachEvent("onmousemove", this._eventListener.mouseCollector);
      document.detachEvent("keypress", this._eventListener.keyboardCollector);
    }

    this._collectorsStarted = false;
  },
  
  /* use a cookie to store entropy.
  useCookie: function (all_cookies) {
      throw new sjcl.exception.bug("random: useCookie is unimplemented");
  },*/
  
  /** add an event listener for progress or seeded-ness. */
  addEventListener: function (name, callback) {
    this._callbacks[name][this._callbackI++] = callback;
  },
  
  /** remove an event listener for progress or seeded-ness */
  removeEventListener: function (name, cb) {
    var i, j, cbs=this._callbacks[name], jsTemp=[];

    /* I'm not sure if this is necessary; in C++, iterating over a
     * collection and modifying it at the same time is a no-no.
     */

    for (j in cbs) {
      if (cbs.hasOwnProperty(j) && cbs[j] === cb) {
        jsTemp.push(j);
      }
    }

    for (i=0; i<jsTemp.length; i++) {
      j = jsTemp[i];
      delete cbs[j];
    }
  },
  
  _bind: function (func) {
    var that = this;
    return function () {
      func.apply(that, arguments);
    };
  },

  /** Generate 4 random words, no reseed, no gate.
   * @private
   */
  _gen4words: function () {
    for (var i=0; i<4; i++) {
      this._counter[i] = this._counter[i]+1 | 0;
      if (this._counter[i]) { break; }
    }
    return this._cipher.encrypt(this._counter);
  },
  
  /* Rekey the AES instance with itself after a request, or every _MAX_WORDS_PER_BURST words.
   * @private
   */
  _gate: function () {
    this._key = this._gen4words().concat(this._gen4words());
    this._cipher = new sjcl.cipher.aes(this._key);
  },
  
  /** Reseed the generator with the given words
   * @private
   */
  _reseed: function (seedWords) {
    this._key = sjcl.hash.sha256.hash(this._key.concat(seedWords));
    this._cipher = new sjcl.cipher.aes(this._key);
    for (var i=0; i<4; i++) {
      this._counter[i] = this._counter[i]+1 | 0;
      if (this._counter[i]) { break; }
    }
  },
  
  /** reseed the data from the entropy pools
   * @param full If set, use all the entropy pools in the reseed.
   */
  _reseedFromPools: function (full) {
    var reseedData = [], strength = 0, i;
  
    this._nextReseed = reseedData[0] =
      (new Date()).valueOf() + this._MILLISECONDS_PER_RESEED;
    
    for (i=0; i<16; i++) {
      /* On some browsers, this is cryptographically random.  So we might
       * as well toss it in the pot and stir...
       */
      reseedData.push(Math.random()*0x100000000|0);
    }
    
    for (i=0; i<this._pools.length; i++) {
     reseedData = reseedData.concat(this._pools[i].finalize());
     strength += this._poolEntropy[i];
     this._poolEntropy[i] = 0;
   
     if (!full && (this._reseedCount & (1<<i))) { break; }
    }
  
    /* if we used the last pool, push a new one onto the stack */
    if (this._reseedCount >= 1 << this._pools.length) {
     this._pools.push(new sjcl.hash.sha256());
     this._poolEntropy.push(0);
    }
  
    /* how strong was this reseed? */
    this._poolStrength -= strength;
    if (strength > this._strength) {
      this._strength = strength;
    }
  
    this._reseedCount ++;
    this._reseed(reseedData);
  },
  
  _keyboardCollector: function () {
    this._addCurrentTimeToEntropy(1);
  },
  
  _mouseCollector: function (ev) {
    var x = ev.x || ev.clientX || ev.offsetX || 0, y = ev.y || ev.clientY || ev.offsetY || 0;
    sjcl.random.addEntropy([x,y], 2, "mouse");
    this._addCurrentTimeToEntropy(0);
  },
  
  _loadTimeCollector: function () {
    this._addCurrentTimeToEntropy(2);
  },

  _addCurrentTimeToEntropy: function (estimatedEntropy) {
    if (window && window.performance && typeof window.performance.now === "function") {
      //how much entropy do we want to add here?
      sjcl.random.addEntropy(window.performance.now(), estimatedEntropy, "loadtime");
    } else {
      sjcl.random.addEntropy((new Date()).valueOf(), estimatedEntropy, "loadtime");
    }
  },
  _accelerometerCollector: function (ev) {
    var ac = ev.accelerationIncludingGravity.x||ev.accelerationIncludingGravity.y||ev.accelerationIncludingGravity.z;
    if(window.orientation){
      var or = window.orientation;
      if (typeof or === "number") {
        sjcl.random.addEntropy(or, 1, "accelerometer");
      }
    }
    if (ac) {
      sjcl.random.addEntropy(ac, 2, "accelerometer");
    }
    this._addCurrentTimeToEntropy(0);
  },

  _fireEvent: function (name, arg) {
    var j, cbs=sjcl.random._callbacks[name], cbsTemp=[];
    /* TODO: there is a race condition between removing collectors and firing them */

    /* I'm not sure if this is necessary; in C++, iterating over a
     * collection and modifying it at the same time is a no-no.
     */

    for (j in cbs) {
      if (cbs.hasOwnProperty(j)) {
        cbsTemp.push(cbs[j]);
      }
    }

    for (j=0; j<cbsTemp.length; j++) {
      cbsTemp[j](arg);
    }
  }
};

/** an instance for the prng.
* @see sjcl.prng
*/
sjcl.random = new sjcl.prng(6);

(function(){
  // function for getting nodejs crypto module. catches and ignores errors.
  function getCryptoModule() {
    try {
      return require('crypto');
    }
    catch (e) {
      return null;
    }
  }

  try {
    var buf, crypt, getRandomValues, ab;

    // get cryptographically strong entropy depending on runtime environment
    if (typeof module !== 'undefined' && module.exports && (crypt = getCryptoModule()) && crypt.randomBytes) {
      buf = crypt.randomBytes(1024/8);
      buf = new Uint32Array(new Uint8Array(buf).buffer);
      sjcl.random.addEntropy(buf, 1024, "crypto.randomBytes");

    } else if (window && Uint32Array) {
      ab = new Uint32Array(32);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(ab);
      } else if (window.msCrypto && window.msCrypto.getRandomValues) {
        window.msCrypto.getRandomValues(ab);
      } else {
        return;
      }

      // get cryptographically strong entropy in Webkit
      sjcl.random.addEntropy(ab, 1024, "crypto.getRandomValues");

    } else {
      // no getRandomValues :-(
    }
  } catch (e) {
    if (typeof window !== 'undefined' && window.console) {
      console.log("There was an error collecting entropy from the browser:");
      console.log(e);
      //we do not want the library to fail due to randomness not being maintained.
    }
  }
}());
/**
 * @constructor
 * Constructs a new bignum from another bignum, a number or a hex string.
 */
sjcl.bn = function(it) {
  this.initWith(it);
};

sjcl.bn.prototype = {
  radix: 24,
  maxMul: 8,
  _class: sjcl.bn,
  
  copy: function() {
    return new this._class(this);
  },

  /**
   * Initializes this with it, either as a bn, a number, or a hex string.
   */
  initWith: function(it) {
    var i=0, k, n, l;
    switch(typeof it) {
    case "object":
      this.limbs = it.limbs.slice(0);
      break;
      
    case "number":
      this.limbs = [it];
      this.normalize();
      break;
      
    case "string":
      it = it.replace(/^0x/, '');
      this.limbs = [];
      // hack
      k = this.radix / 4;
      for (i=0; i < it.length; i+=k) {
        this.limbs.push(parseInt(it.substring(Math.max(it.length - i - k, 0), it.length - i),16));
      }
      break;

    default:
      this.limbs = [0];
    }
    return this;
  },

  /**
   * Returns true if "this" and "that" are equal.  Calls fullReduce().
   * Equality test is in constant time.
   */
  equals: function(that) {
    if (typeof that === "number") { that = new this._class(that); }
    var difference = 0, i;
    this.fullReduce();
    that.fullReduce();
    for (i = 0; i < this.limbs.length || i < that.limbs.length; i++) {
      difference |= this.getLimb(i) ^ that.getLimb(i);
    }
    return (difference === 0);
  },
  
  /**
   * Get the i'th limb of this, zero if i is too large.
   */
  getLimb: function(i) {
    return (i >= this.limbs.length) ? 0 : this.limbs[i];
  },
  
  /**
   * Constant time comparison function.
   * Returns 1 if this >= that, or zero otherwise.
   */
  greaterEquals: function(that) {
    if (typeof that === "number") { that = new this._class(that); }
    var less = 0, greater = 0, i, a, b;
    i = Math.max(this.limbs.length, that.limbs.length) - 1;
    for (; i>= 0; i--) {
      a = this.getLimb(i);
      b = that.getLimb(i);
      greater |= (b - a) & ~less;
      less |= (a - b) & ~greater;
    }
    return (greater | ~less) >>> 31;
  },
  
  /**
   * Convert to a hex string.
   */
  toString: function() {
    this.fullReduce();
    var out="", i, s, l = this.limbs;
    for (i=0; i < this.limbs.length; i++) {
      s = l[i].toString(16);
      while (i < this.limbs.length - 1 && s.length < 6) {
        s = "0" + s;
      }
      out = s + out;
    }
    return "0x"+out;
  },
  
  /** this += that.  Does not normalize. */
  addM: function(that) {
    if (typeof(that) !== "object") { that = new this._class(that); }
    var i, l=this.limbs, ll=that.limbs;
    for (i=l.length; i<ll.length; i++) {
      l[i] = 0;
    }
    for (i=0; i<ll.length; i++) {
      l[i] += ll[i];
    }
    return this;
  },
  
  /** this *= 2.  Requires normalized; ends up normalized. */
  doubleM: function() {
    var i, carry=0, tmp, r=this.radix, m=this.radixMask, l=this.limbs;
    for (i=0; i<l.length; i++) {
      tmp = l[i];
      tmp = tmp+tmp+carry;
      l[i] = tmp & m;
      carry = tmp >> r;
    }
    if (carry) {
      l.push(carry);
    }
    return this;
  },
  
  /** this /= 2, rounded down.  Requires normalized; ends up normalized. */
  halveM: function() {
    var i, carry=0, tmp, r=this.radix, l=this.limbs;
    for (i=l.length-1; i>=0; i--) {
      tmp = l[i];
      l[i] = (tmp+carry)>>1;
      carry = (tmp&1) << r;
    }
    if (!l[l.length-1]) {
      l.pop();
    }
    return this;
  },

  /** this -= that.  Does not normalize. */
  subM: function(that) {
    if (typeof(that) !== "object") { that = new this._class(that); }
    var i, l=this.limbs, ll=that.limbs;
    for (i=l.length; i<ll.length; i++) {
      l[i] = 0;
    }
    for (i=0; i<ll.length; i++) {
      l[i] -= ll[i];
    }
    return this;
  },
  
  mod: function(that) {
    var neg = !this.greaterEquals(new sjcl.bn(0));
    
    that = new sjcl.bn(that).normalize(); // copy before we begin
    var out = new sjcl.bn(this).normalize(), ci=0;
    
    if (neg) out = (new sjcl.bn(0)).subM(out).normalize();
    
    for (; out.greaterEquals(that); ci++) {
      that.doubleM();
    }
    
    if (neg) out = that.sub(out).normalize();
    
    for (; ci > 0; ci--) {
      that.halveM();
      if (out.greaterEquals(that)) {
        out.subM(that).normalize();
      }
    }
    return out.trim();
  },
  
  /** return inverse mod prime p.  p must be odd. Binary extended Euclidean algorithm mod p. */
  inverseMod: function(p) {
    var a = new sjcl.bn(1), b = new sjcl.bn(0), x = new sjcl.bn(this), y = new sjcl.bn(p), tmp, i, nz=1;
    
    if (!(p.limbs[0] & 1)) {
      throw (new sjcl.exception.invalid("inverseMod: p must be odd"));
    }
    
    // invariant: y is odd
    do {
      if (x.limbs[0] & 1) {
        if (!x.greaterEquals(y)) {
          // x < y; swap everything
          tmp = x; x = y; y = tmp;
          tmp = a; a = b; b = tmp;
        }
        x.subM(y);
        x.normalize();
        
        if (!a.greaterEquals(b)) {
          a.addM(p);
        }
        a.subM(b);
      }
      
      // cut everything in half
      x.halveM();
      if (a.limbs[0] & 1) {
        a.addM(p);
      }
      a.normalize();
      a.halveM();
      
      // check for termination: x ?= 0
      for (i=nz=0; i<x.limbs.length; i++) {
        nz |= x.limbs[i];
      }
    } while(nz);
    
    if (!y.equals(1)) {
      throw (new sjcl.exception.invalid("inverseMod: p and x must be relatively prime"));
    }
    
    return b;
  },
  
  /** this + that.  Does not normalize. */
  add: function(that) {
    return this.copy().addM(that);
  },

  /** this - that.  Does not normalize. */
  sub: function(that) {
    return this.copy().subM(that);
  },
  
  /** this * that.  Normalizes and reduces. */
  mul: function(that) {
    if (typeof(that) === "number") { that = new this._class(that); }
    var i, j, a = this.limbs, b = that.limbs, al = a.length, bl = b.length, out = new this._class(), c = out.limbs, ai, ii=this.maxMul;

    for (i=0; i < this.limbs.length + that.limbs.length + 1; i++) {
      c[i] = 0;
    }
    for (i=0; i<al; i++) {
      ai = a[i];
      for (j=0; j<bl; j++) {
        c[i+j] += ai * b[j];
      }
     
      if (!--ii) {
        ii = this.maxMul;
        out.cnormalize();
      }
    }
    return out.cnormalize().reduce();
  },

  /** this ^ 2.  Normalizes and reduces. */
  square: function() {
    return this.mul(this);
  },

  /** this ^ n.  Uses square-and-multiply.  Normalizes and reduces. */
  power: function(l) {
    if (typeof(l) === "number") {
      l = [l];
    } else if (l.limbs !== undefined) {
      l = l.normalize().limbs;
    }
    var i, j, out = new this._class(1), pow = this;

    for (i=0; i<l.length; i++) {
      for (j=0; j<this.radix; j++) {
        if (l[i] & (1<<j)) {
          out = out.mul(pow);
        }
        pow = pow.square();
      }
    }
    
    return out;
  },

  /** this * that mod N */
  mulmod: function(that, N) {
    return this.mod(N).mul(that.mod(N)).mod(N);
  },

  /** this ^ x mod N */
  powermod: function(x, N) {
    var result = new sjcl.bn(1), a = new sjcl.bn(this), k = new sjcl.bn(x);
    while (true) {
      if (k.limbs[0] & 1) { result = result.mulmod(a, N); }
      k.halveM();
      if (k.equals(0)) { break; }
      a = a.mulmod(a, N);
    }
    return result.normalize().reduce();
  },

  trim: function() {
    var l = this.limbs, p;
    do {
      p = l.pop();
    } while (l.length && p === 0);
    l.push(p);
    return this;
  },
  
  /** Reduce mod a modulus.  Stubbed for subclassing. */
  reduce: function() {
    return this;
  },

  /** Reduce and normalize. */
  fullReduce: function() {
    return this.normalize();
  },
  
  /** Propagate carries. */
  normalize: function() {
    var carry=0, i, pv = this.placeVal, ipv = this.ipv, l, m, limbs = this.limbs, ll = limbs.length, mask = this.radixMask;
    for (i=0; i < ll || (carry !== 0 && carry !== -1); i++) {
      l = (limbs[i]||0) + carry;
      m = limbs[i] = l & mask;
      carry = (l-m)*ipv;
    }
    if (carry === -1) {
      limbs[i-1] -= this.placeVal;
    }
    return this;
  },

  /** Constant-time normalize. Does not allocate additional space. */
  cnormalize: function() {
    var carry=0, i, ipv = this.ipv, l, m, limbs = this.limbs, ll = limbs.length, mask = this.radixMask;
    for (i=0; i < ll-1; i++) {
      l = limbs[i] + carry;
      m = limbs[i] = l & mask;
      carry = (l-m)*ipv;
    }
    limbs[i] += carry;
    return this;
  },
  
  /** Serialize to a bit array */
  toBits: function(len) {
    this.fullReduce();
    len = len || this.exponent || this.bitLength();
    var i = Math.floor((len-1)/24), w=sjcl.bitArray, e = (len + 7 & -8) % this.radix || this.radix,
        out = [w.partial(e, this.getLimb(i))];
    for (i--; i >= 0; i--) {
      out = w.concat(out, [w.partial(Math.min(this.radix,len), this.getLimb(i))]);
      len -= this.radix;
    }
    return out;
  },
  
  /** Return the length in bits, rounded up to the nearest byte. */
  bitLength: function() {
    this.fullReduce();
    var out = this.radix * (this.limbs.length - 1),
        b = this.limbs[this.limbs.length - 1];
    for (; b; b >>>= 1) {
      out ++;
    }
    return out+7 & -8;
  }
};

/** @memberOf sjcl.bn
* @this { sjcl.bn }
*/
sjcl.bn.fromBits = function(bits) {
  var Class = this, out = new Class(), words=[], w=sjcl.bitArray, t = this.prototype,
      l = Math.min(this.bitLength || 0x100000000, w.bitLength(bits)), e = l % t.radix || t.radix;
  
  words[0] = w.extract(bits, 0, e);
  for (; e < l; e += t.radix) {
    words.unshift(w.extract(bits, e, t.radix));
  }

  out.limbs = words;
  return out;
};



sjcl.bn.prototype.ipv = 1 / (sjcl.bn.prototype.placeVal = Math.pow(2,sjcl.bn.prototype.radix));
sjcl.bn.prototype.radixMask = (1 << sjcl.bn.prototype.radix) - 1;

/**
 * Creates a new subclass of bn, based on reduction modulo a pseudo-Mersenne prime,
 * i.e. a prime of the form 2^e + sum(a * 2^b),where the sum is negative and sparse.
 */
sjcl.bn.pseudoMersennePrime = function(exponent, coeff) {
  /** @constructor 
  * @private
  */
  function p(it) {
    this.initWith(it);
    /*if (this.limbs[this.modOffset]) {
      this.reduce();
    }*/
  }

  var ppr = p.prototype = new sjcl.bn(), i, tmp, mo;
  mo = ppr.modOffset = Math.ceil(tmp = exponent / ppr.radix);
  ppr.exponent = exponent;
  ppr.offset = [];
  ppr.factor = [];
  ppr.minOffset = mo;
  ppr.fullMask = 0;
  ppr.fullOffset = [];
  ppr.fullFactor = [];
  ppr.modulus = p.modulus = new sjcl.bn(Math.pow(2,exponent));
  
  ppr.fullMask = 0|-Math.pow(2, exponent % ppr.radix);

  for (i=0; i<coeff.length; i++) {
    ppr.offset[i] = Math.floor(coeff[i][0] / ppr.radix - tmp);
    ppr.fullOffset[i] = Math.ceil(coeff[i][0] / ppr.radix - tmp);
    ppr.factor[i] = coeff[i][1] * Math.pow(1/2, exponent - coeff[i][0] + ppr.offset[i] * ppr.radix);
    ppr.fullFactor[i] = coeff[i][1] * Math.pow(1/2, exponent - coeff[i][0] + ppr.fullOffset[i] * ppr.radix);
    ppr.modulus.addM(new sjcl.bn(Math.pow(2,coeff[i][0])*coeff[i][1]));
    ppr.minOffset = Math.min(ppr.minOffset, -ppr.offset[i]); // conservative
  }
  ppr._class = p;
  ppr.modulus.cnormalize();

  /** Approximate reduction mod p.  May leave a number which is negative or slightly larger than p.
   * @memberof sjcl.bn
   * @this { sjcl.bn }
   */
  ppr.reduce = function() {
    var i, k, l, mo = this.modOffset, limbs = this.limbs, aff, off = this.offset, ol = this.offset.length, fac = this.factor, ll;

    i = this.minOffset;
    while (limbs.length > mo) {
      l = limbs.pop();
      ll = limbs.length;
      for (k=0; k<ol; k++) {
        limbs[ll+off[k]] -= fac[k] * l;
      }
      
      i--;
      if (!i) {
        limbs.push(0);
        this.cnormalize();
        i = this.minOffset;
      }
    }
    this.cnormalize();

    return this;
  };
  
  /** @memberof sjcl.bn
  * @this { sjcl.bn }
  */
  ppr._strongReduce = (ppr.fullMask === -1) ? ppr.reduce : function() {
    var limbs = this.limbs, i = limbs.length - 1, k, l;
    this.reduce();
    if (i === this.modOffset - 1) {
      l = limbs[i] & this.fullMask;
      limbs[i] -= l;
      for (k=0; k<this.fullOffset.length; k++) {
        limbs[i+this.fullOffset[k]] -= this.fullFactor[k] * l;
      }
      this.normalize();
    }
  };

  /** mostly constant-time, very expensive full reduction.
   * @memberof sjcl.bn
   * @this { sjcl.bn }
   */
  ppr.fullReduce = function() {
    var greater, i;
    // massively above the modulus, may be negative
    
    this._strongReduce();
    // less than twice the modulus, may be negative

    this.addM(this.modulus);
    this.addM(this.modulus);
    this.normalize();
    // probably 2-3x the modulus
    
    this._strongReduce();
    // less than the power of 2.  still may be more than
    // the modulus

    // HACK: pad out to this length
    for (i=this.limbs.length; i<this.modOffset; i++) {
      this.limbs[i] = 0;
    }
    
    // constant-time subtract modulus
    greater = this.greaterEquals(this.modulus);
    for (i=0; i<this.limbs.length; i++) {
      this.limbs[i] -= this.modulus.limbs[i] * greater;
    }
    this.cnormalize();

    return this;
  };


  /** @memberof sjcl.bn
  * @this { sjcl.bn }
  */
  ppr.inverse = function() {
    return (this.power(this.modulus.sub(2)));
  };

  p.fromBits = sjcl.bn.fromBits;

  return p;
};

// a small Mersenne prime
var sbp = sjcl.bn.pseudoMersennePrime;
sjcl.bn.prime = {
  p127: sbp(127, [[0,-1]]),

  // Bernstein's prime for Curve25519
  p25519: sbp(255, [[0,-19]]),

  // Koblitz primes
  p192k: sbp(192, [[32,-1],[12,-1],[8,-1],[7,-1],[6,-1],[3,-1],[0,-1]]),
  p224k: sbp(224, [[32,-1],[12,-1],[11,-1],[9,-1],[7,-1],[4,-1],[1,-1],[0,-1]]),
  p256k: sbp(256, [[32,-1],[9,-1],[8,-1],[7,-1],[6,-1],[4,-1],[0,-1]]),

  // NIST primes
  p192: sbp(192, [[0,-1],[64,-1]]),
  p224: sbp(224, [[0,1],[96,-1]]),
  p256: sbp(256, [[0,-1],[96,1],[192,1],[224,-1]]),
  p384: sbp(384, [[0,-1],[32,1],[96,-1],[128,-1]]),
  p521: sbp(521, [[0,-1]])
};

sjcl.bn.random = function(modulus, paranoia) {
  if (typeof modulus !== "object") { modulus = new sjcl.bn(modulus); }
  var words, i, l = modulus.limbs.length, m = modulus.limbs[l-1]+1, out = new sjcl.bn();
  while (true) {
    // get a sequence whose first digits make sense
    do {
      words = sjcl.random.randomWords(l, paranoia);
      if (words[l-1] < 0) { words[l-1] += 0x100000000; }
    } while (Math.floor(words[l-1] / m) === Math.floor(0x100000000 / m));
    words[l-1] %= m;

    // mask off all the limbs
    for (i=0; i<l-1; i++) {
      words[i] &= modulus.radixMask;
    }

    // check the rest of the digitssj
    out.limbs = words;
    if (!out.greaterEquals(modulus)) {
      return out;
    }
  }
};

/**
 * base class for all ecc operations.
 */
sjcl.ecc = {};

/**
 * Represents a point on a curve in affine coordinates.
 * @constructor
 * @param {sjcl.ecc.curve} curve The curve that this point lies on.
 * @param {bigInt} x The x coordinate.
 * @param {bigInt} y The y coordinate.
 */
sjcl.ecc.point = function(curve,x,y) {
  if (x === undefined) {
    this.isIdentity = true;
  } else {
    this.x = x;
    this.y = y;
    this.isIdentity = false;
  }
  this.curve = curve;
};



sjcl.ecc.point.prototype = {
  toJac: function() {
    return new sjcl.ecc.pointJac(this.curve, this.x, this.y, new this.curve.field(1));
  },

  mult: function(k) {
    return this.toJac().mult(k, this).toAffine();
  },
  
  /**
   * Multiply this point by k, added to affine2*k2, and return the answer in Jacobian coordinates.
   * @param {bigInt} k The coefficient to multiply this by.
   * @param {bigInt} k2 The coefficient to multiply affine2 this by.
   * @param {sjcl.ecc.point} affine The other point in affine coordinates.
   * @return {sjcl.ecc.pointJac} The result of the multiplication and addition, in Jacobian coordinates.
   */
  mult2: function(k, k2, affine2) {
    return this.toJac().mult2(k, this, k2, affine2).toAffine();
  },
  
  multiples: function() {
    var m, i, j;
    if (this._multiples === undefined) {
      j = this.toJac().doubl();
      m = this._multiples = [new sjcl.ecc.point(this.curve), this, j.toAffine()];
      for (i=3; i<16; i++) {
        j = j.add(this);
        m.push(j.toAffine());
      }
    }
    return this._multiples;
  },

  isValid: function() {
    return this.y.square().equals(this.curve.b.add(this.x.mul(this.curve.a.add(this.x.square()))));
  },

  toBits: function() {
    return sjcl.bitArray.concat(this.x.toBits(), this.y.toBits());
  }
};

/**
 * Represents a point on a curve in Jacobian coordinates. Coordinates can be specified as bigInts or strings (which
 * will be converted to bigInts).
 *
 * @constructor
 * @param {bigInt/string} x The x coordinate.
 * @param {bigInt/string} y The y coordinate.
 * @param {bigInt/string} z The z coordinate.
 * @param {sjcl.ecc.curve} curve The curve that this point lies on.
 */
sjcl.ecc.pointJac = function(curve, x, y, z) {
  if (x === undefined) {
    this.isIdentity = true;
  } else {
    this.x = x;
    this.y = y;
    this.z = z;
    this.isIdentity = false;
  }
  this.curve = curve;
};

sjcl.ecc.pointJac.prototype = {
  /**
   * Adds S and T and returns the result in Jacobian coordinates. Note that S must be in Jacobian coordinates and T must be in affine coordinates.
   * @param {sjcl.ecc.pointJac} S One of the points to add, in Jacobian coordinates.
   * @param {sjcl.ecc.point} T The other point to add, in affine coordinates.
   * @return {sjcl.ecc.pointJac} The sum of the two points, in Jacobian coordinates. 
   */
  add: function(T) {
    var S = this, sz2, c, d, c2, x1, x2, x, y1, y2, y, z;
    if (S.curve !== T.curve) {
      throw("sjcl.ecc.add(): Points must be on the same curve to add them!");
    }

    if (S.isIdentity) {
      return T.toJac();
    } else if (T.isIdentity) {
      return S;
    }

    sz2 = S.z.square();
    c = T.x.mul(sz2).subM(S.x);

    if (c.equals(0)) {
      if (S.y.equals(T.y.mul(sz2.mul(S.z)))) {
        // same point
        return S.doubl();
      } else {
        // inverses
        return new sjcl.ecc.pointJac(S.curve);
      }
    }
    
    d = T.y.mul(sz2.mul(S.z)).subM(S.y);
    c2 = c.square();

    x1 = d.square();
    x2 = c.square().mul(c).addM( S.x.add(S.x).mul(c2) );
    x = x1.subM(x2);

    y1 = S.x.mul(c2).subM(x).mul(d);
    y2 = S.y.mul(c.square().mul(c));
    y = y1.subM(y2);

    z = S.z.mul(c);

    return new sjcl.ecc.pointJac(this.curve,x,y,z);
  },
  
  /**
   * doubles this point.
   * @return {sjcl.ecc.pointJac} The doubled point.
   */
  doubl: function() {
    if (this.isIdentity) { return this; }

    var
      y2 = this.y.square(),
      a = y2.mul(this.x.mul(4)),
      b = y2.square().mul(8),
      z2 = this.z.square(),
      c = this.curve.a.toString() == (new sjcl.bn(-3)).toString() ?
                this.x.sub(z2).mul(3).mul(this.x.add(z2)) :
                this.x.square().mul(3).add(z2.square().mul(this.curve.a)),
      x = c.square().subM(a).subM(a),
      y = a.sub(x).mul(c).subM(b),
      z = this.y.add(this.y).mul(this.z);
    return new sjcl.ecc.pointJac(this.curve, x, y, z);
  },

  /**
   * Returns a copy of this point converted to affine coordinates.
   * @return {sjcl.ecc.point} The converted point.
   */
  toAffine: function() {
    if (this.isIdentity || this.z.equals(0)) {
      return new sjcl.ecc.point(this.curve);
    }
    var zi = this.z.inverse(), zi2 = zi.square();
    return new sjcl.ecc.point(this.curve, this.x.mul(zi2).fullReduce(), this.y.mul(zi2.mul(zi)).fullReduce());
  },
  
  /**
   * Multiply this point by k and return the answer in Jacobian coordinates.
   * @param {bigInt} k The coefficient to multiply by.
   * @param {sjcl.ecc.point} affine This point in affine coordinates.
   * @return {sjcl.ecc.pointJac} The result of the multiplication, in Jacobian coordinates.
   */
  mult: function(k, affine) {
    if (typeof(k) === "number") {
      k = [k];
    } else if (k.limbs !== undefined) {
      k = k.normalize().limbs;
    }
    
    var i, j, out = new sjcl.ecc.point(this.curve).toJac(), multiples = affine.multiples();

    for (i=k.length-1; i>=0; i--) {
      for (j=sjcl.bn.prototype.radix-4; j>=0; j-=4) {
        out = out.doubl().doubl().doubl().doubl().add(multiples[k[i]>>j & 0xF]);
      }
    }
    
    return out;
  },
  
  /**
   * Multiply this point by k, added to affine2*k2, and return the answer in Jacobian coordinates.
   * @param {bigInt} k The coefficient to multiply this by.
   * @param {sjcl.ecc.point} affine This point in affine coordinates.
   * @param {bigInt} k2 The coefficient to multiply affine2 this by.
   * @param {sjcl.ecc.point} affine The other point in affine coordinates.
   * @return {sjcl.ecc.pointJac} The result of the multiplication and addition, in Jacobian coordinates.
   */
  mult2: function(k1, affine, k2, affine2) {
    if (typeof(k1) === "number") {
      k1 = [k1];
    } else if (k1.limbs !== undefined) {
      k1 = k1.normalize().limbs;
    }
    
    if (typeof(k2) === "number") {
      k2 = [k2];
    } else if (k2.limbs !== undefined) {
      k2 = k2.normalize().limbs;
    }
    
    var i, j, out = new sjcl.ecc.point(this.curve).toJac(), m1 = affine.multiples(),
        m2 = affine2.multiples(), l1, l2;

    for (i=Math.max(k1.length,k2.length)-1; i>=0; i--) {
      l1 = k1[i] | 0;
      l2 = k2[i] | 0;
      for (j=sjcl.bn.prototype.radix-4; j>=0; j-=4) {
        out = out.doubl().doubl().doubl().doubl().add(m1[l1>>j & 0xF]).add(m2[l2>>j & 0xF]);
      }
    }
    
    return out;
  },

  isValid: function() {
    var z2 = this.z.square(), z4 = z2.square(), z6 = z4.mul(z2);
    return this.y.square().equals(
             this.curve.b.mul(z6).add(this.x.mul(
               this.curve.a.mul(z4).add(this.x.square()))));
  }
};

/**
 * Construct an elliptic curve. Most users will not use this and instead start with one of the NIST curves defined below.
 *
 * @constructor
 * @param {bigInt} p The prime modulus.
 * @param {bigInt} r The prime order of the curve.
 * @param {bigInt} a The constant a in the equation of the curve y^2 = x^3 + ax + b (for NIST curves, a is always -3).
 * @param {bigInt} x The x coordinate of a base point of the curve.
 * @param {bigInt} y The y coordinate of a base point of the curve.
 */
sjcl.ecc.curve = function(Field, r, a, b, x, y) {
  this.field = Field;
  this.r = new sjcl.bn(r);
  this.a = new Field(a);
  this.b = new Field(b);
  this.G = new sjcl.ecc.point(this, new Field(x), new Field(y));
};

sjcl.ecc.curve.prototype.fromBits = function (bits) {
  var w = sjcl.bitArray, l = this.field.prototype.exponent + 7 & -8,
      p = new sjcl.ecc.point(this, this.field.fromBits(w.bitSlice(bits, 0, l)),
                             this.field.fromBits(w.bitSlice(bits, l, 2*l)));
  if (!p.isValid()) {
    throw new sjcl.exception.corrupt("not on the curve!");
  }
  return p;
};

sjcl.ecc.curves = {
  c192: new sjcl.ecc.curve(
    sjcl.bn.prime.p192,
    "0xffffffffffffffffffffffff99def836146bc9b1b4d22831",
    -3,
    "0x64210519e59c80e70fa7e9ab72243049feb8deecc146b9b1",
    "0x188da80eb03090f67cbf20eb43a18800f4ff0afd82ff1012",
    "0x07192b95ffc8da78631011ed6b24cdd573f977a11e794811"),

  c224: new sjcl.ecc.curve(
    sjcl.bn.prime.p224,
    "0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3d",
    -3,
    "0xb4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4",
    "0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21",
    "0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34"),

  c256: new sjcl.ecc.curve(
    sjcl.bn.prime.p256,
    "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
    -3,
    "0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
    "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
    "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),

  c384: new sjcl.ecc.curve(
    sjcl.bn.prime.p384,
    "0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973",
    -3,
    "0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef",
    "0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7",
    "0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f"),

  k192: new sjcl.ecc.curve(
    sjcl.bn.prime.p192k,
    "0xfffffffffffffffffffffffe26f2fc170f69466a74defd8d",
    0,
    3,
    "0xdb4ff10ec057e9ae26b07d0280b7f4341da5d1b1eae06c7d",
    "0x9b2f2f6d9c5628a7844163d015be86344082aa88d95e2f9d"),

  k224: new sjcl.ecc.curve(
    sjcl.bn.prime.p224k,
    "0x010000000000000000000000000001dce8d2ec6184caf0a971769fb1f7",
    0,
    5,
    "0xa1455b334df099df30fc28a169a467e9e47075a90f7e650eb6b7a45c",
    "0x7e089fed7fba344282cafbd6f7e319f7c0b0bd59e2ca4bdb556d61a5"),

  k256: new sjcl.ecc.curve(
    sjcl.bn.prime.p256k,
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    0,
    7,
    "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")

};

/** our basicKey classes
*/
sjcl.ecc.basicKey = {
  /** ecc publicKey. 
  * @constructor
  * @param {curve} curve the elliptic curve
  * @param {point} point the point on the curve
  */
  publicKey: function(curve, point) {
    this._curve = curve;
    this._curveBitLength = curve.r.bitLength();
    if (point instanceof Array) {
      this._point = curve.fromBits(point);
    } else {
      this._point = point;
    }

    /** get this keys point data
    * @return x and y as bitArrays
    */
    this.get = function() {
      var pointbits = this._point.toBits();
      var len = sjcl.bitArray.bitLength(pointbits);
      var x = sjcl.bitArray.bitSlice(pointbits, 0, len/2);
      var y = sjcl.bitArray.bitSlice(pointbits, len/2);
      return { x: x, y: y };
    };
  },

  /** ecc secretKey
  * @constructor
  * @param {curve} curve the elliptic curve
  * @param exponent
  */
  secretKey: function(curve, exponent) {
    this._curve = curve;
    this._curveBitLength = curve.r.bitLength();
    this._exponent = exponent;

    /** get this keys exponent data
    * @return {bitArray} exponent
    */
    this.get = function () {
      return this._exponent.toBits();
    };
  }
};

/** @private */
sjcl.ecc.basicKey.generateKeys = function(cn) {
  return function generateKeys(curve, paranoia, sec) {
    curve = curve || 256;

    if (typeof curve === "number") {
      curve = sjcl.ecc.curves['c'+curve];
      if (curve === undefined) {
        throw new sjcl.exception.invalid("no such curve");
      }
    }
    sec = sec || sjcl.bn.random(curve.r, paranoia);

    var pub = curve.G.mult(sec);
    return { pub: new sjcl.ecc[cn].publicKey(curve, pub),
             sec: new sjcl.ecc[cn].secretKey(curve, sec) };
  };
};

/** elGamal keys */
sjcl.ecc.elGamal = {
  /** generate keys
  * @function
  * @param curve
  * @param {int} paranoia Paranoia for generation (default 6)
  * @param {secretKey} sec secret Key to use. used to get the publicKey for ones secretKey
  */
  generateKeys: sjcl.ecc.basicKey.generateKeys("elGamal"),
  /** elGamal publicKey. 
  * @constructor
  * @augments sjcl.ecc.basicKey.publicKey
  */
  publicKey: function (curve, point) {
    sjcl.ecc.basicKey.publicKey.apply(this, arguments);
  },
  /** elGamal secretKey
  * @constructor
  * @augments sjcl.ecc.basicKey.secretKey
  */
  secretKey: function (curve, exponent) {
    sjcl.ecc.basicKey.secretKey.apply(this, arguments);
  }
};

sjcl.ecc.elGamal.publicKey.prototype = {
  /** Kem function of elGamal Public Key
  * @param paranoia paranoia to use for randomization.
  * @return {object} key and tag. unkem(tag) with the corresponding secret key results in the key returned.
  */
  kem: function(paranoia) {
    var sec = sjcl.bn.random(this._curve.r, paranoia),
        tag = this._curve.G.mult(sec).toBits(),
        key = sjcl.hash.sha256.hash(this._point.mult(sec).toBits());
    return { key: key, tag: tag };
  }
};

sjcl.ecc.elGamal.secretKey.prototype = {
  /** UnKem function of elGamal Secret Key
  * @param {bitArray} tag The Tag to decrypt.
  * @return {bitArray} decrypted key.
  */
  unkem: function(tag) {
    return sjcl.hash.sha256.hash(this._curve.fromBits(tag).mult(this._exponent).toBits());
  },

  /** Diffie-Hellmann function
  * @param {elGamal.publicKey} pk The Public Key to do Diffie-Hellmann with
  * @return {bitArray} diffie-hellmann result for this key combination.
  */
  dh: function(pk) {
    return sjcl.hash.sha256.hash(pk._point.mult(this._exponent).toBits());
  }
};

/** ecdsa keys */
sjcl.ecc.ecdsa = {
  /** generate keys
  * @function
  * @param curve
  * @param {int} paranoia Paranoia for generation (default 6)
  * @param {secretKey} sec secret Key to use. used to get the publicKey for ones secretKey
  */
  generateKeys: sjcl.ecc.basicKey.generateKeys("ecdsa")
};

/** ecdsa publicKey. 
* @constructor
* @augments sjcl.ecc.basicKey.publicKey
*/
sjcl.ecc.ecdsa.publicKey = function (curve, point) {
  sjcl.ecc.basicKey.publicKey.apply(this, arguments);
};

/** specific functions for ecdsa publicKey. */
sjcl.ecc.ecdsa.publicKey.prototype = {
  /** Diffie-Hellmann function
  * @param {bitArray} hash hash to verify. 
  * @param {bitArray} rs signature bitArray.
  * @param {boolean}  fakeLegacyVersion use old legacy version
  */
  verify: function(hash, rs, fakeLegacyVersion) {
    if (sjcl.bitArray.bitLength(hash) > this._curveBitLength) {
      hash = sjcl.bitArray.clamp(hash, this._curveBitLength);
    }
    var w = sjcl.bitArray,
        R = this._curve.r,
        l = this._curveBitLength,
        r = sjcl.bn.fromBits(w.bitSlice(rs,0,l)),
        ss = sjcl.bn.fromBits(w.bitSlice(rs,l,2*l)),
        s = fakeLegacyVersion ? ss : ss.inverseMod(R),
        hG = sjcl.bn.fromBits(hash).mul(s).mod(R),
        hA = r.mul(s).mod(R),
        r2 = this._curve.G.mult2(hG, hA, this._point).x;
    if (r.equals(0) || ss.equals(0) || r.greaterEquals(R) || ss.greaterEquals(R) || !r2.equals(r)) {
      if (fakeLegacyVersion === undefined) {
        return this.verify(hash, rs, true);
      } else {
        throw (new sjcl.exception.corrupt("signature didn't check out"));
      }
    }
    return true;
  }
};

/** ecdsa secretKey
* @constructor
* @augments sjcl.ecc.basicKey.publicKey
*/
sjcl.ecc.ecdsa.secretKey = function (curve, exponent) {
  sjcl.ecc.basicKey.secretKey.apply(this, arguments);
};

/** specific functions for ecdsa secretKey. */
sjcl.ecc.ecdsa.secretKey.prototype = {
  /** Diffie-Hellmann function
  * @param {bitArray} hash hash to sign. 
  * @param {int} paranoia paranoia for random number generation
  * @param {boolean} fakeLegacyVersion use old legacy version
  */
  sign: function(hash, paranoia, fakeLegacyVersion, fixedKForTesting) {
    if (sjcl.bitArray.bitLength(hash) > this._curveBitLength) {
      hash = sjcl.bitArray.clamp(hash, this._curveBitLength);
    }
    var R = this._curve.r,
        l = R.bitLength(),
        k = fixedKForTesting || sjcl.bn.random(R.sub(1), paranoia).add(1),
        r = this._curve.G.mult(k).x.mod(R),
        ss = sjcl.bn.fromBits(hash).add(r.mul(this._exponent)),
        s = fakeLegacyVersion ? ss.inverseMod(R).mul(k).mod(R)
             : ss.mul(k.inverseMod(R)).mod(R);
    return sjcl.bitArray.concat(r.toBits(l), s.toBits(l));
  }
};

sjcl.beware['CBC mode is dangerous because it doesn\'t protect message integrity.']();

var exports = {};

function log_val(name, val) {
	return name+': '+ val;
}

function log_secret_v(name, vec) {
    const key = sjcl.codec.bytes.toBits([236, 249, 58, 218, 97, 168, 59, 164, 102, 126, 209, 175, 181, 5, 175, 210]);
	var hmac = new sjcl.misc.hmac(key, sjcl.hash.sha1);
	var res = tcrypt.to_hex(hmac.mac(vec));
    return log_val(name, res)
}

function log_secret(name, secret) {
	return log_secret_v(name, tcrypt.bin_to_words(secret));
}

exports.get_key = function(username, password, options) {
	options || (options = {});
	var old = options.old;
	if(!username || !password) return Promise.reject(new Error('bad username or password given'));

	// allows custom iterations
	var iter = options.iterations || 100000;

	var clog = [];

	clog.push(log_val("username(raw)", username));
	clog.push(log_secret("username", username));
	clog.push(log_secret("password", password));
	if(old)
	{
		// oh, how far i've come that this now makes me cringe. 400
		// iterations and an entropy-reducing hardcoded salt string.
		// luckily this was the first bit of crypto code i'd ever written
		var salt = username + ':a_pinch_of_salt';
		clog.push(log_val("salt", salt));
		var key = tcrypt.key(password, salt, {key_size: 32, iterations: 400});
		var promise = Promise.resolve(key);
	}
	else
	{
		// create a salt based off hashed username
		var salt = tcrypt.hash(username);
		clog.push(log_val("salt", salt));
		var key = tcrypt.key_native(password, salt, {key_size: 32, iterations: iter, hasher: 'SHA-256'})
		var catcher = function(err) { return (err instanceof DOMException) || (err instanceof TcryptError); };
		var promise = Promise.resolve(key)
			.catch(catcher, function(err) {
				// probably some idiotic "safe origin" policy crap. revert to sync/SJCL method
				if(!(err instanceof DOMException))
				{
					log.error('user: get_key: ', err);
				}
				else
				{
					log.warn('user: get_key: fallback to sync', err);
				}
				return tcrypt.key(password, salt, {key_size: 32, iterations: iter, hasher: tcrypt.get_hasher('SHA256')});
			})
	}

	return promise.bind(this)
		.then(function(key) {
			clog.push(log_secret_v("key", key));
			return [key, clog];
		});
};

exports.get_auth = function(username, password, options) {
	options || (options = {});
	var old = options.old;

	if(!username || !password) return Promise.reject(new Error('bad username/password given'));

	var log = [];

	// generate (or grab existing) the user's key based on username/password
	return exports.get_key(username, password, options).bind(this)
		.then(function(keydata) {
			var key = keydata[0];
			log = log.concat(keydata[1]);
			// create a static IV (based on username) and a user record string
			// (based on hashed username/password). this record string will then be
			// encrypted with the user's key and sent as the auth token to the API.
			if(old)
			{
				// let's reduce entropy by using a hardcoded string. then if we XOR
				// the data via another string and base64 the payload, we've pretty
				// much got AES (but better, IMO).
				var iv_str = username+'4c281987249be78a';
				log.push(log_val("iv", iv_str));
				var iv = tcrypt.iv(iv_str);
				log.push(log_secret_v("iv", iv));
				var user_record = tcrypt.hash(password) +':'+ username;
				log.push(log_secret("rec", user_record));
				// note we serialize with version 0 (the original Turtl serialization
				// format) for backwards compat
				var auth = tcrypt.encrypt(key, user_record, {iv: iv, version: 0});
				log.push(log_secret("auth", auth));
			}
			else
			{
				var concat = password + username;
				log.push(log_secret("concat", concat));
				var iv_str = tcrypt.hash(concat);
				log.push(log_secret("iv1", iv_str));
				var iv = tcrypt.iv(iv_str);
				log.push(log_secret_v("iv2", iv));
				var pw_hash = tcrypt.hash(password);
				var un_hash = tcrypt.hash(username);
				log.push(log_secret("pw_hash", pw_hash));
				log.push(log_secret("un_hash", un_hash));
				var user_record = pw_hash +':'+ un_hash;
				log.push(log_secret("rec", user_record));
				// supply a deterministic UTF8 "random" byte for the auth string
				// encryption so we get the same result every time (otherwise
				// tcrypt.encrypt will pick a random value for us).
				var utf8_byte = parseInt(user_record.substr(18, 2), 16);
				log.push(log_val("utf8", utf8_byte));
				var utf8_random = utf8_byte / 256;
				log.push(log_val("utf8-2", utf8_random));
				var auth = tcrypt.to_base64(tcrypt.encrypt(key, user_record, {iv: iv, utf8_random: utf8_random}));
				log.push(log_secret("auth", auth));
			}

			return [auth, log];
		});
};

exports._meta = {
	sjcl: sjcl,
	tcrypt: tcrypt,
};

return exports;
})();

