const fs = require("fs");
const { google } = require("googleapis");
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const port = 3000;

const crypto = require("crypto");
const qs = require("qs");

const slackMiddleware = fn => (req, res, next) => {
  try {
    var slackSignature = req.headers["x-slack-signature"];
    var requestBody = qs.stringify(req.body, { format: "RFC1738" });
    var timestamp = req.headers["x-slack-request-timestamp"];
    var time = Math.floor(new Date().getTime() / 1000);
    if (Math.abs(time - timestamp) > 300) {
      return res.status(400).send("Ignore this request.");
    }

    var sigBasestring = "v0:" + timestamp + ":" + requestBody;
    var mySignature =
      "v0=" +
      crypto
        .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
        .update(sigBasestring, "utf8")
        .digest("hex");

    if (
      crypto.timingSafeEqual(
        Buffer.from(mySignature, "utf8"),
        Buffer.from(slackSignature, "utf8")
      )
    ) {
      next();
    } else {
      return res.status(400).send("Verification failed");
    }
  } catch (e) {
    return res.status(400).send("Error validating request.");
  }
};

const asyncMiddleware = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const rooms = {
  "nan-labs.com_3138383836383039323930@resource.calendar.google.com": {
    name: "The Lab",
    alias: "lab",
    id: "nan-labs.com_3138383836383039323930@resource.calendar.google.com"
  },
  "nan-labs.com_2d34353438333338322d313637@resource.calendar.google.com": {
    name: "The Bunker",
    alias: "bunker",
    id: "nan-labs.com_2d34353438333338322d313637@resource.calendar.google.com"
  },
  "nan-labs.com_3136333139383335313834@resource.calendar.google.com": {
    name: "The Studio",
    alias: "studio",
    id: "nan-labs.com_3136333139383335313834@resource.calendar.google.com"
  },
  "nan-labs.com_39343734393235333739@resource.calendar.google.com": {
    name: "The Hive",
    alias: "hive",
    id: "nan-labs.com_39343734393235333739@resource.calendar.google.com"
  }
};

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly"
];

// The file tokens.json stores the users access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time for each new user.
const TOKENS_PATH = "tokens.json";

const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
var tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));

app.use(bodyParser.urlencoded({ extended: true }));

app.use(slackMiddleware());

app.get("/", (req, res) => res.send("It works!"));

function storeTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens), "utf8");
  return tokens;
}

function getOAuth2Client(credentials) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

app.post(
  "/ncal",
  asyncMiddleware(async (req, res) => {
    const oAuth2Client = getOAuth2Client(credentials);

    if (!tokens.hasOwnProperty(req.body.user_id)) {
      try {
        // assume auth code if user doesn't exist
        const res = await oAuth2Client.getToken(req.body.text);
        tokens = storeTokens({ ...tokens, [req.body.user_id]: res.res.data });
      } catch (e) {
        const authLink = oAuth2Client.generateAuthUrl({
          access_type: "offline",
          scope: SCOPES
        });
        res.send(
          `Please log in and send the token from: <${authLink}|Auth> like this: \`/ncal [token]\`\nAfter this you can ask for a free room calling \`/ncal\` without arguments.`
        );
        return;
      }
    }

    oAuth2Client.setCredentials(tokens[req.body.user_id]);

    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 3600 * 0.5 * 1000).toISOString();

    // look up for available rooms
    const roomAvailability = await calendar.freebusy.query({
      resource: {
        timeMin: from,
        timeMax: to,
        timeZone: "America/Buenos_Aires",
        items: Object.keys(rooms).map(id => ({ id }))
      }
    });

    const freeRooms = Object.keys(roomAvailability.data.calendars)
      .reduce((acc, item) => {
        return [
          ...acc,
          {
            ...rooms[item],
            busy: roomAvailability.data.calendars[item].busy.length !== 0
          }
        ];
      }, [])
      .filter(r => !r.busy);

    if (!freeRooms.length) {
      res.send("No free room. You can always use Learning :party_parrot:");
      return;
    }

    // if a room is selected and available, use it.
    // if not, choose the first available based in the preference order

    // create event (15/30 mins) from now

    var event = {
      summary: `${req.body.user_name} - Quick reservation`,
      description: "",
      start: {
        dateTime: from,
        timeZone: "America/Buenos_Aires"
      },
      end: {
        dateTime: to,
        timeZone: "America/Buenos_Aires"
      },
      attendees: [
        {
          email: freeRooms[0].id
        }
      ]
    };

    calendar.events.insert(
      {
        calendarId: "primary",
        resource: event
      },
      (err, r) => {
        // send confirmation (link to the event)
        if (err) {
          res.send(
            "Algo salio mal :(\nDecile a <@UMER3B8B1> o tirate un PR en https://github.com/vmari/ncal"
          );
          return;
        }
        const event = r.data;
        res.json({
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Quick event created:"
              }
            },
            {
              type: "divider"
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*<${event.htmlLink}|${event.summary}>*\n*Room:*\n${
                  event.location
                }\n*Duration:*\n30min`
              },
              accessory: {
                type: "image",
                image_url:
                  "https://api.slack.com/img/blocks/bkb_template_images/notifications.png",
                alt_text: "calendar thumbnail"
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `*Meet link:* ${event.hangoutLink}`
                }
              ]
            }
          ]
        });
      }
    );
  })
);

app.listen(port, () => console.log(`App started at port ${port}!`));
