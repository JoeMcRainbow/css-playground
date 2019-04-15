'use strict';

var config = require('./config');
var BugTracker = require('./bugtracker');
var bugtracker = new BugTracker('server');
var express = require('express');
var gitApi = require('./git-api');
var winston = require('winston');
var sysinfo = require('./sysinfo');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var semver = require('semver');
var path = require('path');
var fs = require('./utils/fs-async');
var signals = require('signals');
var os = require('os');
var cache = require('./utils/cache');
var UngitPlugin = require('./ungit-plugin');
var serveStatic = require('serve-static');
var bodyParser = require('body-parser');
var Bluebird = require('bluebird');

process.on('uncaughtException', function (err) {
  winston.error(err.stack ? err.stack.toString() : err.toString());
  bugtracker.notify.bind(bugtracker, err, 'ungit-launcher');
  app.quit();
});

console.log('Setting log level to ' + config.logLevel);
winston.remove(winston.transports.Console);
winston.add(winston.transports.Console, {
  level: config.logLevel,
  timestamp: true,
  colorize: true
});
if (config.logDirectory) winston.add(winston.transports.File, { filename: path.join(config.logDirectory, 'server.log'), maxsize: 100 * 1024, maxFiles: 2 });

var users = config.users;
config.users = null; // So that we don't send the users to the client

if (config.authentication) {

  passport.serializeUser(function (username, done) {
    done(null, username);
  });

  passport.deserializeUser(function (username, done) {
    done(null, users[username] !== undefined ? username : null);
  });

  passport.use(new LocalStrategy(function (username, password, done) {
    if (users[username] !== undefined && password === users[username]) done(null, username);else done(null, false, { message: 'No such username/password' });
  }));
}

var app = express();
var server = require('http').createServer(app);

gitApi.pathPrefix = '/api';

app.use(function (req, res, next) {
  var rootPath = config.rootPath;
  if (req.url === rootPath) {
    // always have a trailing slash
    res.redirect(req.url + '/');
    return;
  }
  if (req.url.indexOf(rootPath) === 0) {
    req.url = req.url.substring(rootPath.length);
    next();
    return;
  }
  res.send(400).end();
});

if (config.logRESTRequests) {
  app.use(function (req, res, next) {
    winston.info(req.method + ' ' + req.url);
    next();
  });
}

if (config.allowedIPs) {
  app.use(function (req, res, next) {
    var ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
    if (config.allowedIPs.indexOf(ip) >= 0) next();else {
      res.status(403).send(403, '<h3>This host is not authorized to connect</h3>' + '<p>You are trying to connect to an Ungit instance from an unathorized host.</p>');
      winston.warn('Host trying but not authorized to connect: ' + ip);
    }
  });
}

var noCache = function noCache(req, res, next) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};
app.use(noCache);

app.use(require('body-parser').json());

if (config.autoShutdownTimeout) {
  var autoShutdownTimeout = void 0;
  var refreshAutoShutdownTimeout = function refreshAutoShutdownTimeout() {
    if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout);
    autoShutdownTimeout = setTimeout(function () {
      winston.info('Shutting down ungit due to unactivity. (autoShutdownTimeout is set to ' + config.autoShutdownTimeout + 'ms)');
      process.exit(0);
    }, config.autoShutdownTimeout);
  };
  app.use(function (req, res, next) {
    refreshAutoShutdownTimeout();
    next();
  });
  refreshAutoShutdownTimeout();
}

var ensureAuthenticated = function ensureAuthenticated(req, res, next) {
  next();
};

if (config.authentication) {
  var cookieParser = require('cookie-parser');
  var session = require('express-session');
  var MemoryStore = require('memorystore')(session);
  app.use(cookieParser());
  app.use(session({
    store: new MemoryStore({
      checkPeriod: 86400000 // prune expired entries every 24h
    }),
    secret: 'ungit'
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  app.post('/api/login', function (req, res, next) {
    passport.authenticate('local', function (err, user, info) {
      if (err) {
        return next(err);
      }
      if (!user) {
        res.status(401).json({ errorCode: 'authentication-failed', error: info.message });
        return;
      }
      req.logIn(user, function (err) {
        if (err) {
          return next(err);
        }
        res.json({ ok: true });
        return;
      });
    })(req, res, next);
  });

  app.get('/api/loggedin', function (req, res) {
    if (req.isAuthenticated()) res.json({ loggedIn: true });else res.json({ loggedIn: false });
  });

  app.get('/api/logout', function (req, res) {
    req.logout();
    res.json({ ok: true });
  });

  ensureAuthenticated = function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }
    res.status(401).json({ errorCode: 'authentication-required', error: 'You have to authenticate to access this resource' });
  };
}

var indexHtmlCacheKey = cache.registerFunc(function () {
  return cache.resolveFunc(pluginsCacheKey).then(function (plugins) {
    return fs.readFileAsync(__dirname + '/../public/index.html').then(function (data) {
      return Bluebird.all(Object.keys(plugins).map(function (pluginName) {
        return plugins[pluginName].compile();
      })).then(function (results) {
        data = data.toString().replace('<!-- ungit-plugins-placeholder -->', results.join('\n\n'));
        data = data.replace(/__ROOT_PATH__/g, config.rootPath);

        return data;
      });
    });
  });
});

app.get('/', function (req, res) {
  if (config.dev) {
    cache.invalidateFunc(pluginsCacheKey);
    cache.invalidateFunc(indexHtmlCacheKey);
  }
  cache.resolveFunc(indexHtmlCacheKey).then(function (data) {
    res.end(data);
  });
});

app.use(serveStatic(__dirname + '/../public'));

// Socket-IO
var socketIO = require('socket.io');
var socketsById = {};
var socketIdCounter = 0;
var io = socketIO.listen(server, {
  path: config.rootPath + '/socket.io',
  logger: {
    debug: winston.debug.bind(winston),
    info: winston.info.bind(winston),
    error: winston.error.bind(winston),
    warn: winston.warn.bind(winston)
  }
});
io.sockets.on('connection', function (socket) {
  var socketId = socketIdCounter++;
  socketsById[socketId] = socket;
  socket.socketId = socketId;
  socket.emit('connected', { socketId: socketId });
  socket.on('disconnect', function () {
    return delete socketsById[socketId];
  });
});

var apiEnvironment = {
  app: app,
  server: server,
  ensureAuthenticated: ensureAuthenticated,
  config: config,
  pathPrefix: gitApi.pathPrefix,
  socketIO: io,
  socketsById: socketsById
};

gitApi.registerApi(apiEnvironment);

// Init plugins
var loadPlugins = function loadPlugins(plugins, pluginBasePath) {
  fs.readdirSync(pluginBasePath).forEach(function (pluginDir) {
    var pluginPath = path.join(pluginBasePath, pluginDir);
    // if not a directory or doesn't contain an ungit-plugin.json, just skip it.
    if (!fs.lstatSync(pluginPath).isDirectory() || !fs.existsSync(path.join(pluginPath, 'ungit-plugin.json'))) {
      return;
    }
    winston.info('Loading plugin: ' + pluginPath);
    var plugin = new UngitPlugin({
      dir: pluginDir,
      httpBasePath: 'plugins/' + pluginDir,
      path: pluginPath
    });
    if (plugin.manifest.disabled || plugin.config.disabled) {
      winston.info('Plugin disabled: ' + pluginDir);
      return;
    }
    plugin.init(apiEnvironment);
    plugins.push(plugin);
    winston.info('Plugin loaded: ' + pluginDir);
  });
};
var pluginsCacheKey = cache.registerFunc(function () {
  var plugins = [];
  loadPlugins(plugins, path.join(__dirname, '..', 'components'));
  if (fs.existsSync(config.pluginDirectory)) {
    loadPlugins(plugins, config.pluginDirectory);
  }
  return plugins;
});

app.get('/serverdata.js', function (req, res) {
  sysinfo.getUserHash().then(function (hash) {
    var text = 'ungit.config = ' + JSON.stringify(config) + ';\n' + ('ungit.userHash = "' + hash + '";\n') + ('ungit.version = "' + config.ungitDevVersion + '";\n') + ('ungit.platform = "' + os.platform() + '"\n') + ('ungit.pluginApiVersion = "' + require('../package.json').ungitPluginApiVersion + '"\n');
    res.send(text);
  });
});

app.get('/api/latestversion', function (req, res) {
  sysinfo.getUngitLatestVersion().then(function (latestVersion) {
    if (!semver.valid(config.ungitDevVersion)) {
      res.json({
        latestVersion: latestVersion,
        currentVersion: config.ungitDevVersion,
        outdated: false
      });
    } else {
      // We only want to show the "new version" banner if the major/minor version was bumped
      var latestSansPatch = semver(latestVersion);
      latestSansPatch.patch = 0;
      var currentSansPatch = semver(config.ungitDevVersion);
      currentSansPatch.patch = 0;
      res.json({
        latestVersion: latestVersion,
        currentVersion: config.ungitDevVersion,
        outdated: semver.gt(latestSansPatch, currentSansPatch)
      });
    }
  }).catch(function (err) {
    res.json({ latestVersion: config.ungitDevVersion, currentVersion: config.ungitDevVersion, outdated: false });
  });
});

app.get('/api/ping', function (req, res) {
  return res.json({});
});

app.get('/api/gitversion', function (req, res) {
  sysinfo.getGitVersionInfo().then(function (result) {
    return res.json(result);
  });
});

var userConfigPath = path.join(config.homedir, '.ungitrc');
var readUserConfig = function readUserConfig() {
  return fs.isExists(userConfigPath).then(function (hasConfig) {
    if (!hasConfig) return {};
    return fs.readFileAsync(userConfigPath, { encoding: 'utf8' }).then(function (content) {
      return JSON.parse(content.toString());
    }).catch(function (err) {
      winston.error('Stop at reading ~/.ungitrc because ' + err);
      process.exit(0);
    });
  });
};
var writeUserConfig = function writeUserConfig(configContent) {
  return fs.writeFileAsync(userConfigPath, JSON.stringify(configContent, undefined, 2));
};

app.get('/api/userconfig', ensureAuthenticated, function (req, res) {
  readUserConfig().then(function (userConfig) {
    res.json(userConfig);
  }).catch(function (err) {
    res.status(400).json(err);
  });
});
app.post('/api/userconfig', ensureAuthenticated, function (req, res) {
  writeUserConfig(req.body).then(function () {
    res.json({});
  }).catch(function (err) {
    res.status(400).json(err);
  });
});

app.get('/api/fs/exists', ensureAuthenticated, function (req, res) {
  res.json(fs.existsSync(req.query['path']));
});

app.get('/api/fs/listDirectories', ensureAuthenticated, function (req, res) {
  var dir = path.resolve(req.query.term.trim()).replace("/~", "");

  fs.readdirAsync(dir).then(function (filenames) {
    return filenames.map(function (filename) {
      return path.join(dir, filename);
    });
  }).filter(function (filepath) {
    return fs.statAsync(filepath).then(function (stat) {
      return stat.isDirectory();
    }).catch(function () {
      return false;
    });
  }).then(function (filteredFiles) {
    filteredFiles.unshift(dir);
    res.json(filteredFiles);
  }).catch(function (err) {
    return res.status(400).json(err);
  });
});

// Error handling
app.use(function (err, req, res, next) {
  bugtracker.notify(err, 'ungit-node');
  winston.error(err.stack);
  res.status(500).send({ error: err.message, errorType: err.name, stack: err.stack });
});

exports.started = new signals.Signal();

server.listen(config.port, config.ungitBindIp, function () {
  winston.info('Listening on port ' + config.port);
  console.log('## Ungit started ##'); // Consumed by bin/ungit to figure out when the app is started
  exports.started.dispatch();
});
