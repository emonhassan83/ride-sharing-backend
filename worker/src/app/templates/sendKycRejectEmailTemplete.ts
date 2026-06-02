// sendKycRejectionEmailTemplete.ts
const sendKycRejectionEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 25px;">
    <h1 style="color: #dc3545; margin: 0;">KYC Verification Update</h1>
  </div>
  
  <p style="font-size: 16px; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  
  <p style="font-size: 16px; line-height: 1.6;">
    Unfortunately, your KYC verification has been <strong>rejected</strong>.
  </p>

  <div style="background: #fff3cd; border-left: 5px solid #ffc107; padding: 20px; margin: 25px 0; border-radius: 6px;">
    <p style="margin: 0 0 10px 0; font-weight: bold; color: #856404;">Reason for Rejection:</p>
    <p style="margin: 0; color: #856404;">{{reason}}</p>
  </div>

  <p style="font-size: 16px; line-height: 1.6;">
    Please review the issues and <strong>resubmit</strong> your documents with correct information.
  </p>

  <p style="margin-top: 25px; font-size: 15px;">
    If you need any assistance, feel free to contact our support team.
  </p>

  <p style="margin-top: 30px;">Best regards,<br/><strong>Team SplitRide Support</strong></p>
</div>
`;

export default sendKycRejectionEmail;