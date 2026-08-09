// sendKycRejectionEmailTemplete.ts
const sendKycRejectionEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; border: 1px solid #d4d4d4; border-radius: 12px; background-color: #ffffff; overflow: hidden;">
  <div style="background-color: #1a1a1a; padding: 22px 30px;">
    <h3 style="color: #ffffff; margin: 0; font-size: 18px; letter-spacing: 0.3px;">KYC Verification Update</h3>
    <p style="color: #cfcfcf; margin: 6px 0 0 0; font-size: 13px;">Please review and resubmit your documents</p>
  </div>

  <div style="padding: 30px;">
    <p style="margin: 0 0 14px 0; color: #333333; font-size: 14px; line-height: 1.6;">Dear <strong style="color: #1a1a1a;">{{name}}</strong>,</p>
    <p style="margin: 0 0 22px 0; color: #555555; font-size: 14px; line-height: 1.6;">Unfortunately, your KYC verification was not approved. Please review the reason below and resubmit your documents with the correct information.</p>

    <p style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 14px; font-weight: bold;">Reason:</p>
    <div style="background-color: #f7f7f7; border-left: 3px solid #4d4d4d; padding: 14px 16px; border-radius: 6px; color: #333333; font-size: 14px; line-height: 1.6;">
      {{reason}}
    </div>

    <p style="margin: 22px 0 0 0; color: #555555; font-size: 14px; line-height: 1.6;">If you need help, please contact the support team.</p>

    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;"/>
    <p style="margin: 0; color: #777777; font-size: 13px; line-height: 1.6;">Best regards,<br/><strong style="color: #1a1a1a;">SplitRide Support</strong></p>
  </div>
</div>
`;

export default sendKycRejectionEmail;
