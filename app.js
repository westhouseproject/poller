var settings = require('./settings');
var request = require('request');
var influx = require('influx');
var async = require('async');
var _ = require('lodash');
var util = require('util');
var path = require('path');
var fs = require('fs');

var cert = fs.readFileSync(path.join(__dirname, 'settings', 'keys.cert'));
var key = fs.readFileSync(path.join(__dirname, 'settings', 'keys.key'));
var ca = fs.readFileSync(path.join(__dirname, 'settings', 'ca.cert'));

// Unlike the name implies, this isn't used to store the data temporarily in
// order for faster retrieval the next time. Instead, this is for holding the
// previous kWh value.
var cache = {};

const looptimeout = settings.get('looptimeout') || 1000;

var session = null;

// function getSession() {
//   request({
//     url: settings.get('dbms:url_prefix') + '/login',
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json'
//     },
//     body: JSON.stringify(_.pick(settings.get('dbms'), 'username', 'password'))
//   }, function (err, res, body) {
//     if (err) {
//       return console.error(err);
//     }
//     if (res && res.statusCode >= 400) {
//       return console.error(
//         '%s: %s: Got POST response with status code %s:\n%s',
//         new Date(),
//         settings.get('dbms:url_prefix'),
//         res.statusCode,
//         body
//       );
//     }
//     session = JSON.parse(body).token;
//   });
// }

// This will infinite loop.
(function loop() {

  // Steps:
  //
  // 1. insert devices into the database, if they don't exist.
  // 2. insert the collected data into the database.
  async.waterfall([

    // Download data from the middleware.
    function (callback) {
      // Get all current values being read from mControl.
      request({
        // TODO: rename `remote:url_prefix` to `middleware:url_prefix`.
        url: settings.get('middleware:url_prefix') + '/current',
      }, function (err, res, body) {
        if (err) { return callback(err); }
        if (!res || res.statusCode >= 400) { return callback(new Error(body)); }


        // We should get a JSON body that looks like:
        //
        //   [
        //     {
        //       series: <string> 
        //       device_id: <string>
        //       value: <number>
        //       time: <ISO 8601 date string>
        //     }
        //   ]
        //
        // Possibly with some of the above aforementioned properties being
        // omitted. In those case, just interpret the missing property as an
        // empty array.
        // TODO: ensure that the JSON data is valid.
        try {
          var json = JSON.parse(body);
        } catch (e) {
          return callback(e);
        }

        if (err) {
          return callback(err);
        }
        var currentTime = new Date().toISOString();

        // This performs the difference between the last time the energy
        // consumption data was read, and this time. If there was no "last
        // time," then simply don't send the data to the DBMS.
        json.filter(function (element) {
          if (!/^(energy_consumption|solar_pv_energy)$/.test(element.series)) {
            return true;
          }
          if (
            typeof cache[element.device_id] === 'undefined' ||
            element.value < cache[element.device_id]
          ) {
            cache[element.device_id] = element.value;
            return false;
          }
          var old = element.value;
          element.value = element.value - cache[element.device_id];
          cache[element.device_id] = old;
          return true;
        });

        json.forEach(function (object) {
          object.time = currentTime;
        });

        callback(null, json);
      });
    },

    // Send the collected data to the database.
    function (json, callback) {
      request({
        url: settings.get('dbms:url_prefix') + '/data',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        cert: cert,
        key: key,
        ca: ca,
        rejectUnauthorized: false,
        body: JSON.stringify({
          data: json,
          session: session
        })
      }, function (err, res, body) {
        if (err) { return callback(err); }
        // if (res && res.statusCode >= 400) {
        //   if (res.statusCode === 403) {
        //     getSession();
        //   }
        //   return callback(
        //     util.format(
        //       'Got POST response with status code %s:\n%s',
        //       res.statusCode,
        //       body
        //     )
        //   );
        // }
        callback(null);
      })
    },
  ], function (err) {
    if (err) { console.error(err); }
    setTimeout(function () {
      loop();
    }, looptimeout);
  });
})();
