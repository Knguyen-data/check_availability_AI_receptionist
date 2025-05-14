# Setup and Run Instructions

Follow these steps to set up and run the AI Receptionist Webhook:

## 1. Install dependencies

```bash
npm install
```

## 2. Check your .env file

Make sure you have the `.env` file in the root directory with the following content:

```
OPENAI_API_KEY=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
CAL_API_KEY=cal_live_e2368b6e119ef41b554a2f161c321b69
PORT=8080
```

## 3. Start the server

```bash
node index.js
```

## 4. Test the webhook

The webhook will be available at:
```
http://localhost:8080/webhook/0bb1d791-61d0-4c82-bd04-319dca34a25d
```

You can test it with a POST request using curl, Postman, or any API testing tool:

```bash
curl -X POST http://localhost:8080/webhook/0bb1d791-61d0-4c82-bd04-319dca34a25d \
  -H "Content-Type: application/json" \
  -d '{"bookingtime": "next Tuesday at 2pm", "assigned_stylist": "angelina@creativenails.ca", "duration_of_services": "60 minutes"}'
```

## Troubleshooting

If you encounter issues with the OpenAI API key, try regenerating the key or checking for any whitespace in your .env file.

For Cal.com API issues, verify that your Cal.com account is properly set up and the API key has the necessary permissions.