const sendSupportReplyEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; border: 1px solid #d4d4d4; border-radius: 12px; background-color: #ffffff; overflow: hidden;">
  
  <div style="background-color: #1a1a1a; padding: 20px 30px;">
    <h3 style="color: #ffffff; margin: 0; font-size: 18px; letter-spacing: 0.3px;">New Support Message</h3>
  </div>

  <div style="padding: 30px;">
    <p style="margin: 0 0 12px 0; color: #333333; font-size: 14px;">
      <strong style="color: #1a1a1a;">From:</strong> 
      <span style="color: #555555;">SplitRide Support ({{fromEmail}})</span>
    </p>

    <p style="margin: 0 0 20px 0; color: #333333; font-size: 14px;">
      <strong style="color: #1a1a1a;">Subject:</strong> 
      <span style="color: #555555;">{{subj}}</span>
    </p>

    <p style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 14px; font-weight: bold;">Message:</p>
    <div style="background-color: #f5f5f5; border-left: 3px solid #4d4d4d; padding: 14px 16px; border-radius: 6px; color: #333333; font-size: 14px; line-height: 1.6;">
      {{messages}}
    </div>

    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;"/>

    <p style="margin: 0; color: #888888; font-size: 12px; font-style: italic;">
      Sent via Support Ticket ID: {{support.id}}
    </p>
  </div>

</div>
`;

export default sendSupportReplyEmail;

