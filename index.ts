import express, { Request, Response } from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import bodyParser from 'body-parser';

dotenv.config(); // Load environment variables

const app = express();
const port = 3000;

// Twilio credentials from environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID as string;
const authToken = process.env.TWILIO_AUTH_TOKEN as string;
const twilioClient = twilio(accountSid, authToken);

// OpenAI API key from environment variables
const openaiApiKey = process.env.OPENAI_API_KEY as string;
const openai = new OpenAI({ apiKey: openaiApiKey });

// Use bodyParser to parse URL-encoded and JSON request bodies
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Conversation storage (in-memory)
interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversations: { [callSid: string]: ConversationMessage[] } = {};

const INITIAL_MESSAGE = "Hello, how are you?";

const SYSTEM_PROMPT = `
You are a helpful phone assistant for a pizza restaurant.
The restaurant is open between 10 AM and 12 PM.
You can help the customer reserve a table for the restaurant.
`;

app.post('/twilio-webhook', (req: Request, res: Response) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;

  if (!conversations[callSid]) {
    // This is a new conversation!
    conversations[callSid] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'assistant',
        content: INITIAL_MESSAGE,
      },
    ];
    twiml.say(INITIAL_MESSAGE);
  }

  // Use <Gather> to capture speech input
  const gather = twiml.gather({
    input: ['speech'],
    action: '/process-speech',
    method: 'POST',
    timeout: 2,
    speechTimeout: 'auto',
    // Optionally, you can specify speechModel and enhanced if needed
    speechModel: 'experimental_conversations',
    enhanced: true,
  });

  // If you want to include a prompt within the gather
  // gather.say('Please tell me how I can assist you.');

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/process-speech', async (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  if (!callSid || !speechResult) {
    // Handle cases where speech was not recognized
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, I did not catch that.');
    twiml.redirect('/twilio-webhook');

    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  let messages = conversations[callSid];

  if (!messages) {
    // Initialize conversation if not found (shouldn't happen)
    messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'assistant',
        content: INITIAL_MESSAGE,
      },
    ];
    conversations[callSid] = messages;
  }

  // Add user's speech to the conversation
  messages.push({ role: 'user', content: speechResult });

  try {
    // Generate response using OpenAI's ChatGPT
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      temperature: 0,
    });

    const assistantResponse = chatCompletion.choices[0].message?.content;

    if (assistantResponse) {
      // Add assistant's response to the conversation
      messages.push({ role: 'assistant', content: assistantResponse });

      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say(assistantResponse);
      twiml.redirect('/twilio-webhook'); // Continue the conversation

      res.type('text/xml');
      res.send(twiml.toString());
    } else {
      // Handle case where assistant response is undefined
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say('Sorry, there was an error processing your request.');
      twiml.redirect('/twilio-webhook');

      res.type('text/xml');
      res.send(twiml.toString());
    }
  } catch (error) {
    console.error('Error generating response from OpenAI:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, there was an error processing your request.');
    twiml.redirect('/twilio-webhook');

    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
