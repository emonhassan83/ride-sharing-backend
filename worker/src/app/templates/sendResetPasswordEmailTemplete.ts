// sendResetPasswordEmailTemplete.ts
const sendResetPasswordEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; border: 1px solid #d4d4d4; border-radius: 12px; background-color: #ffffff; overflow: hidden;">
  <div style="background-color: #1a1a1a; padding: 22px 30px;">
    <h3 style="color: #ffffff; margin: 0; font-size: 18px; letter-spacing: 0.3px;">Password Reset Request</h3>
    <p style="color: #cfcfcf; margin: 6px 0 0 0; font-size: 13px;">Use this code to reset your password</p>
  </div>

  <div style="padding: 30px;">
    <p style="margin: 0 0 14px 0; color: #333333; font-size: 14px; line-height: 1.6;">Dear <strong style="color: #1a1a1a;">{{name}}</strong>,</p>
    <p style="margin: 0 0 22px 0; color: #555555; font-size: 14px; line-height: 1.6;">We received a request to reset your password. Use the code below to continue.</p>

    <div style="text-align: center; margin: 26px 0;">
      <div style="display: inline-block; background-color: #f2f2f2; border: 1px solid #d9d9d9; border-radius: 10px; padding: 16px 28px; color: #1a1a1a; font-size: 32px; font-weight: bold; letter-spacing: 6px;">
        {{otp}}
      </div>
    </div>

    <div style="background-color: #f7f7f7; border-left: 3px solid #4d4d4d; padding: 14px 16px; border-radius: 6px; color: #444444; font-size: 13px; line-height: 1.6;">
      This code is valid for 10 minutes. If you did not request a password reset, please disregard this email.
    </div>

    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;"/>
    <p style="margin: 0; color: #777777; font-size: 13px; line-height: 1.6;">Best regards,<br/><strong style="color: #1a1a1a;">SplitRide Team</strong></p>
  </div>
</div>
`;

export default sendResetPasswordEmail;
