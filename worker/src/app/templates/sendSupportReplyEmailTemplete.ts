// sendSupportReplyEmailTemplete.ts
const sendSupportReplyEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
  <h3>New Support Message</h3>
  <p><strong>From:</strong> {{support.email}}</p>
  <p><strong>Subject:</strong> {{subj}}</p>
  <p><strong>Message:</strong></p>
  <p>{{messages}}</p>
  <hr/>
  <p><em>Sent via Support Ticket ID: {{support._id}}</em></p>
</div>
`;

export default sendSupportReplyEmail;