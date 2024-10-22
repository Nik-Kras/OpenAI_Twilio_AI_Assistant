import express, { Request, Response } from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';
import OpenAI, { toFile } from "openai";
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import FormData from 'form-data';

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

// Serve static files from the 'public' directory
app.use('/public', express.static('public'));

// Ensure the audio directory exists
const audioDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// Conversation storage (in-memory)
interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversations: { [callSid: string]: ConversationMessage[] } = {};

const INITIAL_MESSAGE = 'Доброго дня, як я можу вам допомогти?'

const SYSTEM_PROMPT = `
Ви помічник кол-центру, який працює в друкарні. Ваше завдання приймати дзвінки від клієнтів і допомагати їм записувати їх звернення. Вони дзвонять, щоб зробити конкретне замовлення, і ви повинні допомогти їм надати вам необхідні деталі для замовлення.

Ви повинні мати можливість вести детальні розмови з клієнтами, які, можливо, не знають точно, що їм потрібно. Ставте уточнюючі запитання та надавайте пропозиції, щоб допомогти їм прийняти обґрунтовані рішення. Наприклад, якщо клієнт не впевнений щодо типу паперу для свого завдання друку, запропонуйте варіанти на кшталт «Ви б віддали перевагу глянцевому чи матовому?» або "Як щодо того, щоб спробувати наші варіанти екологічно чистого паперу?"

Задавайте одне запитання за раз, щоб забезпечити ясність і направляти клієнта через кожну частину замовлення.

# Приклади сценаріїв:

## Розмова 1:
Клієнт: «Привіт, мені потрібно надрукувати плакати».
AI: «Звичайно! Скільки плакатів ви б хотіли надрукувати?»
Клієнт: "Я не впевнений, можливо, близько 50?"
AI: «Ми можемо це зробити. Хочете, щоб ці плакати були кольоровими чи чорно-білими?»
Замовник: «Повний колір».
AI: "Чудовий вибір! Ви маєте на увазі певний розмір чи хочете отримати пропозиції?"
Клієнт: "Які розміри ви пропонуєте?"
AI: «Ми пропонуємо різні розміри, як-от A3, A2 і нестандартні розміри. Для плакатів формат A2 досить популярний. Ви б хотіли вибрати розмір A2?»
Клієнт: «Так, A2 звучить добре».
AI: «Ідеально. У вас є готовий дизайн, чи вам потрібна наша допомога?»
Замовник: «У мене готовий дизайн».
AI: «Чудово. Я запишу ваше замовлення на 50 повноколірних плакатів формату А2. Вам сьогодні ще щось потрібно?»
Клієнт: "Ні, це все. Дякую!"
AI: «Нема за що! Ваше замовлення записано, і ми негайно приступимо до нього. Гарного дня!»

## Розмова 2:
Клієнт: «Привіт, мені потрібні візитки для наших нових співробітників».
AI: «Звичайно! Скільки візиток ви б хотіли надрукувати?»
Клієнт: «У нас 10 нових співробітників, тому, можливо, по 100 карток кожному».
AI: «Зрозумів. У вас є готовий дизайн чи хочете, щоб ми його створили для вас?»
Замовник: «У нас готовий дизайн».
AI: «Ідеально. Який тип паперу ви віддасте перевагу для візитних карток? У нас є такі варіанти, як матовий, глянцевий і текстурований».
Клієнт: «Глянцевий звучить добре».
AI: "Чудовий вибір. Вам потрібні якісь спеціальні обробки, як-от тиснення чи тиснення фольгою?"
Клієнт: «Так, ми б хотіли, щоб логотип компанії був тиснений».
AI: «Зрозуміло. Я запишу ваш запит на 1000 глянцевих візитних карток з тисненими логотипами для 10 співробітників. Щось ще вам потрібно сьогодні?»
Клієнт: "Ні, це все. Дякую!"
AI: «Нема за що! Ваше замовлення записано, і ми негайно приступимо до нього. Гарного дня!»
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
  }

  // Generate the TTS audio for the initial message
  (async () => {
    const audioFilename = `${uuidv4()}.mp3`;
    const audioFilePath = path.join(audioDir, audioFilename);
    const assistantResponse = INITIAL_MESSAGE;

    console.log(`Generating TTS for: ${assistantResponse}`);

    try {
      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: assistantResponse
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      await fs.promises.writeFile(audioFilePath, buffer);

      console.log(`Audio file saved at: ${audioFilePath}`);

      const audioUrl = `${req.protocol}://${req.get('host')}/public/audio/${audioFilename}`;
      console.log(`Audio URL: ${audioUrl}`);

      twiml.play(audioUrl);

      // Use <Record> to capture the user's speech
      twiml.record({
        action: '/process-recording',
        method: 'POST',
        maxLength: 30,
        playBeep: true,
        trim: 'do-not-trim',
      });

      res.type('text/xml');
      res.send(twiml.toString());
    } catch (error) {
      console.error('Error generating TTS audio:', error);
      twiml.say('Вибачте, сталася помилка при обробці вашого запиту.');
      res.type('text/xml');
      res.send(twiml.toString());
    }
  })();
});

app.post('/process-recording', async (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;

  console.log(`Processing recording for CallSid: ${callSid}`);
  console.log(`Recording URL: ${recordingUrl}`);

  if (!callSid || !recordingUrl) {
    console.log('Invalid CallSid or RecordingUrl');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Вибачте, я не зміг записати ваше повідомлення.');
    twiml.redirect('/twilio-webhook');

    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  let messages = conversations[callSid];

  if (!messages) {
    console.log('No existing conversation found, initializing a new one.');
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

  try {
    // Transcribe the recording using OpenAI's Whisper API
    const speechResult = await transcribeWithWhisper(recordingUrl);
    console.log(`Transcription result: ${speechResult}`);

    // Add user's speech to the conversation
    messages.push({ role: 'user', content: speechResult });

    // Generate response using OpenAI's ChatGPT
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      temperature: 0,
    });

    const assistantResponse = chatCompletion.choices[0].message?.content;
    console.log(`Assistant response: ${assistantResponse}`);

    if (assistantResponse) {
      // Add assistant's response to the conversation
      messages.push({ role: 'assistant', content: assistantResponse });

      // Generate TTS audio using OpenAI's API
      const audioFilename = `${uuidv4()}.mp3`;
      const audioFilePath = path.join(audioDir, audioFilename);

      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: assistantResponse
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      await fs.promises.writeFile(audioFilePath, buffer);

      console.log(`Audio response saved at: ${audioFilePath}`);

      const audioUrl = `${req.protocol}://${req.get('host')}/public/audio/${audioFilename}`;
      console.log(`Assistant audio URL: ${audioUrl}`);

      const twiml = new twilio.twiml.VoiceResponse();
      twiml.play(audioUrl);

      // Loop back to record the next user input
      twiml.record({
        action: '/process-recording',
        method: 'POST',
        maxLength: 30,
        playBeep: true,
        trim: 'do-not-trim',
      });

      res.type('text/xml');
      res.send(twiml.toString());
    } else {
      console.log('Assistant response was undefined.');
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say('Вибачте, сталася помилка при обробці вашого запиту.');
      twiml.redirect('/twilio-webhook');

      res.type('text/xml');
      res.send(twiml.toString());
    }
  } catch (error) {
    console.error('Error processing recording:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Вибачте, сталася помилка при обробці вашого запиту.');
    twiml.redirect('/twilio-webhook');

    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// // Function to download the recording from Twilio using the correct recording SID
// const downloadRecording = async (recordingUrl: string, filePath: string): Promise<string> => {
//   try {
//     // Extract the recording SID from the recording URL (e.g., https://api.twilio.com/2010-04-01/Accounts/.../Recordings/RExxxxxxxxxxxxxxxxxxxxxxxx)
//     const recordingSid = path.basename(recordingUrl); // This extracts "RExxxxxxxxxxxxxxxxxxxxxxxx" from the URL
//     console.log("Sid")
//     console.log(recordingUrl)
//     console.log(recordingSid)

//     const recording = await twilioClient.recordings(recordingSid).fetch();
//     const recordingUri = `${recording.uri}.mp3`; // Get recording URI in MP3 format

//     // Use axios to download the recording
//     const response = await axios({
//       url: `https://api.twilio.com${recordingUri}`,
//       method: 'GET',
//       responseType: 'stream',
//       auth: {
//         username: accountSid,
//         password: authToken,
//       },
//     });

//     // Save the recording to a file
//     const writer = fs.createWriteStream(filePath);
//     response.data.pipe(writer);

//     return new Promise((resolve, reject) => {
//       writer.on('finish', () => {
//         console.log('Recording downloaded successfully!');
//         resolve(filePath);
//       });

//       writer.on('error', (err) => {
//         console.error('Error downloading the recording:', err);
//         reject(err);
//       });
//     });
//   } catch (error) {
//     console.error('Failed to download the recording:', error);
//     throw error;
//   }
// };

// Function to add a sleep/delay for the given duration in milliseconds
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to download the recording file
async function downloadTwilioRecording(url: string, filePath: string) {
  try {
    // Use axios to send a GET request with basic authentication
    await sleep(5000);
    // Make a request to Twilio to get the composition media
    const compResponse = await twilioClient.request({
      method: 'get',
      uri: url,
    });
    console.log(compResponse)

    const response = await axios({
      url: url,
      method: 'GET',
      responseType: 'stream', // Ensures the response is a stream for downloading the file
      auth: {
        username: accountSid,
        password: authToken,
      },
    });

    // Create a write stream to save the file
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    // Return a promise that resolves when the file is written
    return new Promise<void>((resolve, reject) => {
      writer.on('finish', () => {
        console.log('Recording downloaded successfully to:', filePath);
        resolve();
      });

      writer.on('error', (err) => {
        console.error('Error downloading the recording:', err);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Failed to download the recording:', error);
    throw error;
  }
}

// Function to transcribe the downloaded audio file with Whisper
async function transcribeWithWhisper(recordingUrl: string): Promise<string> {
  const filePath = path.join(__dirname, 'recording.mp3');

  // Step 1: Download the Twilio recording
  const downloadedFilePath = await downloadTwilioRecording(recordingUrl, filePath);
  console.log(downloadTwilioRecording)
  console.log(`Recording downloaded at: ${filePath}`);

  // Step 2: Read the audio file into a buffer
  const audioBuffer = fs.readFileSync(filePath);
  const file = new File([audioBuffer], "recording.mp3", { type: 'audio/mpeg' });

  console.log("Sending audio file to Whisper API for transcription...");

  // Step 3: Send the file to OpenAI's Whisper API for transcription
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: 'uk', // Specify language, adjust if necessary
  });

  console.log(`Transcription received: ${transcription.text}`);
  return transcription.text;
}


// Route to handle call status callbacks
app.post('/call-status', (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  if (callStatus === 'completed') {
    // Call has ended, print the conversation
    const messages = conversations[callSid];
    if (messages) {
      console.log(`\nConversation for CallSid ${callSid}:`);
      messages.forEach((message) => {
        console.log(`${message.role}: ${message.content}`);
      });

      // Optionally, remove the conversation from memory
      delete conversations[callSid];
    } else {
      console.log(`No conversation found for CallSid ${callSid}.`);
    }
  }

  res.sendStatus(200); // Acknowledge receipt of the callback
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});