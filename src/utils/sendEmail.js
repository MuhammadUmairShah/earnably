const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'ab8663001@smtp-brevo.com';

async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is missing');
  }

  console.log('Sending email via Brevo API to:', to);
  console.log('EMAIL_FROM:', EMAIL_FROM);

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: 'EarnyX',
        email: EMAIL_FROM,
      },
      to: [
        {
          email: to,
        },
      ],
      subject,
      htmlContent: html,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('Brevo email failed:', {
      status: response.status,
      body: text,
    });

    throw new Error(`Brevo email failed: ${response.status} ${text}`);
  }

  console.log('Email sent successfully:', text);
  return text ? JSON.parse(text) : {};
}

module.exports = sendEmail;