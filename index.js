const passport = require("passport-strategy");
const util = require("util");
const xmlCrypto = require("xml-crypto");
const xmlbuilder = require("xmlbuilder");
const saml = require("passport-saml").SAML;
const Q = require("q");

const DOMParser = require("xmldom").DOMParser;

const { createLogger, format, transports } = require("winston");
const { combine, timestamp, label, printf } = format;

const getMethod = "GET";
const postMethod = "POST";

const logger = createLogger({
  level: process.env.NODE_ENV !== "production" ? "debug" : "info",
  format: combine(
    label({ label: "spid-passport" }),
    timestamp(),
    format.splat(),
    printf(info => {
      return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
    })
  ),
  transports: [new transports.Console()]
});

function SpidStrategy(options, verify) {
  if (typeof options === "function") {
    verify = options;
    options = {};
  }

  if (!verify) {
    throw new Error("SAML authentication strategy requires a verify function");
  }

  this.name = "spid";

  passport.Strategy.call(this);

  this.spidOptions = options;
  this._verify = verify;
  this._passReqToCallback = !!options.passReqToCallback;
  this._authnRequestBinding = "HTTP-Redirect";
}

util.inherits(SpidStrategy, passport.Strategy);

SpidStrategy.prototype.authenticate = function(req, options) {
  const self = this;

  // Since authenticate function handles GET and POST requests we log request body
  // (it should contain SAMLResponse) for POST requests, for GET cases we log entityID and authLevel
  if (req.method === postMethod) {
    logger.debug("SPID raw POST request: %s\n", JSON.stringify(req.body));
  } else if (req.method === getMethod) {
    logger.debug(
      "SPID GET request entityID: %s - authLevel: %s\n",
      req.query.entityID,
      req.query.authLevel
    );
  } else {
    logger.debug("SPID request method: %s\n", req.method);
  }

  const decodedResponse =
    req.body && req.body.SAMLResponse
      ? decodeBase64(req.body.SAMLResponse)
      : undefined;
  if (req.method === postMethod) {
    logger.debug("SPID decoded POST request: %s\n", decodedResponse);
  }

  const spidOptions = Object.assign({}, this.spidOptions.sp);

  const entityID = req.query.entityID;
  if (entityID !== undefined) {
    const idp = this.spidOptions.idp[entityID];
    // given entityID is not in spidOptions
    if (idp === undefined) {
      logger.error(
        "SPID cannot find a valid idp in spidOptions for given entityID: %s",
        entityID
      );
    }
    spidOptions.entryPoint = idp.entryPoint;
    spidOptions.cert = idp.cert;
  } else {
    // Check against all IDP certs if we don't have an entityID
    const idps = this.spidOptions.idp;
    spidOptions.cert = Object.keys(idps).reduce(
      (certs, k) => certs.concat(idps[k].cert),
      []
    );
  }

  const authLevel = req.query.authLevel;
  if (authLevel !== undefined) {
    spidOptions.authnContext = getSpidAuthLevelUrl(authLevel);
    if (spidOptions.authnContext === undefined) {
      logger.error(
        "SPID cannot find a valid authnContext for given authLevel: %s",
        authLevel
      );
    } else {
      logger.debug("SPID Response authnContext: %s", spidOptions.authnContext);
    }
    spidOptions.forceAuthn = authLevel === "SpidL1" ? false : true;
  } else if (decodedResponse) {
    const xmlResponse = new DOMParser().parseFromString(decodedResponse);

    // <saml2:AuthnContextClassRef>https://www.spid.gov.it/SpidL2</saml2:AuthnContextClassRef>
    const responseAuthLevelEl = xmlResponse.getElementsByTagNameNS(
      "urn:oasis:names:tc:SAML:2.0:assertion",
      "AuthnContextClassRef"
    );

    if (responseAuthLevelEl[0]) {
      spidOptions.authnContext = responseAuthLevelEl[0].textContent.trim();
      // check if the parsed value is a valid Spid AuthLevel Url
      if (getSpidAuthLevel(spidOptions.authnContext) !== undefined) {
        logger.debug(
          "SPID Response authnContext: %s",
          spidOptions.authnContext
        );
      } else {
        logger.error(
          "SPID Response authnContext has a wrong value: %s",
          spidOptions.authnContext
        );
      }
    } else {
      logger.error(
        "SPID cannot find assertion namespace in xmlResponse %s",
        decodedResponse
      );
    }
  }

  const samlClient = new saml(spidOptions);

  options.samlFallback = options.samlFallback || "login-request";

  function validateCallback(err, profile, loggedOut) {
    if (err) {
      return self.error(err);
    }

    if (loggedOut) {
      req.logout();
      if (profile) {
        req.samlLogoutRequest = profile;
        return samlClient.getLogoutResponseUrl(req, redirectIfSuccess);
      }
      return self.pass();
    }

    const verified = function(err, user, info) {
      if (err) {
        return self.error(err);
      }

      if (!user) {
        return self.fail(info);
      }

      self.success(user, info);
    };

    if (self._passReqToCallback) {
      self._verify(req, profile, verified);
    } else {
      self._verify(profile, verified);
    }
  }

  function redirectIfSuccess(err, url) {
    if (err) {
      self.error(err);
    } else {
      self.redirect(url);
    }
  }

  if (req.body && req.body.SAMLResponse) {
    samlClient.validatePostResponse(req.body, validateCallback);
  } else if (req.body && req.body.SAMLRequest) {
    samlClient.validatePostRequest(req.body, validateCallback);
  } else {
    const requestHandler = {
      "login-request": function() {
        getAuthorizeUrl(req, samlClient, redirectIfSuccess);
      }.bind(self),
      "logout-request": function() {
        samlClient.getLogoutUrl(req, redirectIfSuccess);
      }.bind(self)
    }[options.samlFallback];

    if (typeof requestHandler !== "function") {
      logger.debug(
        "SPID requestHandler is not a function: %s",
        typeof requestHandler
      );
      return self.fail();
    }

    requestHandler();
  }
};

SpidStrategy.prototype.logout = function(req, callback) {
  const spidOptions = Object.assign({}, this.spidOptions.sp);

  const entityID = req.query.entityID;
  if (entityID !== undefined) {
    const idp = this.spidOptions.idp[entityID];
    spidOptions.entryPoint = idp.entryPoint;
    spidOptions.cert = idp.cert;
  }

  const samlClient = new saml(spidOptions);

  samlClient.getLogoutUrl(req, callback);
};

SpidStrategy.prototype.generateServiceProviderMetadata = function(
  decryptionCert
) {
  const spidOptions = Object.assign({}, this.spidOptions.sp);
  const samlClient = new saml(spidOptions);

  const metadata = {
    EntityDescriptor: {
      "@xmlns": "urn:oasis:names:tc:SAML:2.0:metadata",
      "@xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
      "@entityID": spidOptions.issuer,
      "@ID": spidOptions.issuer.replace(/\W/g, "_"),
      SPSSODescriptor: {
        "@protocolSupportEnumeration": "urn:oasis:names:tc:SAML:2.0:protocol",
        "@AuthnRequestsSigned": true,
        "@WantAssertionsSigned": true
      }
    }
  };

  if (spidOptions.decryptionPvk) {
    if (!decryptionCert) {
      throw new Error(
        "Missing decryptionCert while generating metadata for decrypting service provider"
      );
    }

    decryptionCert = decryptionCert.replace(/-+BEGIN CERTIFICATE-+\r?\n?/, "");
    decryptionCert = decryptionCert.replace(/-+END CERTIFICATE-+\r?\n?/, "");
    decryptionCert = decryptionCert.replace(/\r\n/g, "\n");

    metadata.EntityDescriptor.SPSSODescriptor.KeyDescriptor = {
      "@use": "signing",
      "ds:KeyInfo": {
        "ds:X509Data": {
          "ds:X509Certificate": {
            "#text": decryptionCert
          }
        }
      },
      EncryptionMethod: [
        // this should be the set that the xmlenc library supports
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#aes256-cbc" },
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#aes128-cbc" },
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#tripledes-cbc" }
      ]
    };
  }

  if (spidOptions.logoutCallbackUrl) {
    metadata.EntityDescriptor.SPSSODescriptor.SingleLogoutService = {
      "@Binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
      "@Location": spidOptions.logoutCallbackUrl
    };
  }

  metadata.EntityDescriptor.SPSSODescriptor.NameIDFormat =
    spidOptions.identifierFormat;
  metadata.EntityDescriptor.SPSSODescriptor.AssertionConsumerService = {
    "@index": spidOptions.attributeConsumingServiceIndex,
    "@isDefault": "true",
    "@Binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    "@Location": samlClient.getCallbackUrl({})
  };

  if (spidOptions.attributes) {
    function getFriendlyName(name) {
      const friendlyNames = {
        name: "Nome",
        familyName: "Cognome",
        fiscalNumber: "Codice fiscale",
        email: "Email",
        mobilePhone: "Numero di telefono"
      };

      return friendlyNames[name];
    }

    const attributes = spidOptions.attributes.attributes.map(function(item) {
      return {
        "@Name": item,
        "@NameFormat":
          "urn:oasis:names:tc:SAML:2.0:attrname-format:basic",
        "@FriendlyName": getFriendlyName(item)
      };
    });

    metadata.EntityDescriptor.SPSSODescriptor.AttributeConsumingService = {
      "@index": spidOptions.attributeConsumingServiceIndex,
      ServiceName: {
        "@xml:lang": "it",
        "#text": spidOptions.attributes.name
      },
      RequestedAttribute: attributes
    };
  }

  if (spidOptions.organization) {
    metadata.EntityDescriptor.Organization = {
      OrganizationName: {
        "@xml:lang": "it",
        "#text": spidOptions.organization.name
      },
      OrganizationDisplayName: {
        "@xml:lang": "it",
        "#text": spidOptions.organization.displayName
      },
      OrganizationURL: {
        "@xml:lang": "it",
        "#text": spidOptions.organization.URL
      }
    };
  }

  const xml = xmlbuilder.create(metadata).end({
    pretty: true,
    indent: "  ",
    newline: "\n"
  });

  function MyKeyInfo(file) {
    this.file = file;

    this.getKeyInfo = function(key, prefix) {
      prefix = prefix || "";
      prefix = prefix ? prefix + ":" : prefix;
      return (
        "<" +
        prefix +
        "X509Data><X509Certificate>" +
        decryptionCert +
        "</X509Certificate></" +
        prefix +
        "X509Data>"
      );
    };

    this.getKey = function(keyInfo) {
      return this.file;
    };
  }

  var sig = new xmlCrypto.SignedXml();
  sig.signingKey = spidOptions.privateCert;
  sig.keyInfoProvider = new MyKeyInfo(decryptionCert);
  sig.addReference(
    "//*[local-name(.)='EntityDescriptor']",
    [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#"
    ],
    "http://www.w3.org/2001/04/xmlenc#sha256"
  );
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.computeSignature(xml,{
    location: { reference: "", action: "prepend" } // Place the signature tag before all other tags
  });

  return sig.getSignedXml();
};

const getAuthorizeUrl = function(req, samlClient, callback) {
  generateAuthorizeRequest(req, samlClient, function(err, request) {
    if (err) return callback(err);
    var operation = "authorize";
    samlClient.requestToUrl(
      request,
      null,
      operation,
      samlClient.getAdditionalParams(req, operation),
      callback
    );
  });
};

const generateAuthorizeRequest = function(req, samlClient, callback) {
  var self = this;
  var id = "_" + samlClient.generateUniqueID();
  var instant = samlClient.generateInstant();
  var forceAuthn = samlClient.options.forceAuthn || false;

  Q.fcall(function() {
    if (samlClient.options.validateInResponseTo) {
      return Q.ninvoke(samlClient.cacheProvider, "save", id, instant);
    } else {
      return Q();
    }
  })
    .then(function() {
      var request = {
        "samlp:AuthnRequest": {
          "@xmlns:samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
          "@ID": id,
          "@Version": "2.0",
          "@IssueInstant": instant,
          "@ProtocolBinding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
          "@AssertionConsumerServiceURL": samlClient.getCallbackUrl(req),
          "@Destination": samlClient.options.entryPoint,
          "saml:Issuer": {
            "@xmlns:saml": "urn:oasis:names:tc:SAML:2.0:assertion",
            "@NameQualifier": samlClient.options.issuer,
            "@Format": "urn:oasis:names:tc:SAML:2.0:nameid-format:entity",
            "#text": samlClient.options.issuer
          }
        }
      };

      if (forceAuthn) {
        request["samlp:AuthnRequest"]["@ForceAuthn"] = true;
      }

      if (samlClient.options.identifierFormat) {
        request["samlp:AuthnRequest"]["samlp:NameIDPolicy"] = {
          "@xmlns:samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
          "@Format": samlClient.options.identifierFormat
        };
      }

      if (!samlClient.options.disableRequestedAuthnContext) {
        request["samlp:AuthnRequest"]["samlp:RequestedAuthnContext"] = {
          "@xmlns:samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
          "@Comparison": "exact",
          "saml:AuthnContextClassRef": {
            "@xmlns:saml": "urn:oasis:names:tc:SAML:2.0:assertion",
            "#text": samlClient.options.authnContext
          }
        };
      }

      if (
        samlClient.options.attributeConsumingServiceIndex ||
        samlClient.options.attributeConsumingServiceIndex === 0
      ) {
        request["samlp:AuthnRequest"]["@AttributeConsumingServiceIndex"] =
          samlClient.options.attributeConsumingServiceIndex;
      }

      if (samlClient.options.providerName) {
        request["samlp:AuthnRequest"]["@ProviderName"] =
          samlClient.options.providerName;
      }
      callback(null, xmlbuilder.create(request).end());
    })
    .fail(function(err) {
      callback(err);
    })
    .done();
};

/**
 * from a given authLevel it returns the Spid auth level url
 */
const getSpidAuthLevelUrl = function(authLevel) {
  switch (authLevel) {
    case "SpidL1":
      return "https://www.spid.gov.it/SpidL1";
    case "SpidL2":
      return "https://www.spid.gov.it/SpidL2";
    case "SpidL3":
      return "https://www.spid.gov.it/SpidL3";
  }
};

/**
 * from a given authLevelUrl it returns the Spid Auth Level
 */
const getSpidAuthLevel = function(authLevelUrl) {
  switch (authLevelUrl) {
    case "https://www.spid.gov.it/SpidL1":
      return "SpidL1";
    case "https://www.spid.gov.it/SpidL2":
      return "SpidL2";
    case "https://www.spid.gov.it/SpidL3":
      return "SpidL3";
  }
};

const decodeBase64 = function(s) {
  return new Buffer(s, "base64").toString("utf8");
};

module.exports = SpidStrategy;
