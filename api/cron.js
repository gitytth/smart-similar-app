export default function handler(request, response) {
  response.status(200).send('Cron job endpoint is ready.');
}