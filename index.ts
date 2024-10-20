import express, { Request, Response } from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = 3000;

// Twilio credentials (replace these with your actual account credentials)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

app.use(express.urlencoded({ extended: true }));

// Route to handle incoming calls
app.post('/twilio-webhook', (req: Request, res: Response) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // AI-powered response (for now, we'll just return a simple message)
  twiml.say('Hello, this is your AI answering the call! How can I help you today?');

  // Send the response back to Twilio
  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
