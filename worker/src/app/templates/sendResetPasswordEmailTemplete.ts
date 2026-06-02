// sendResetPasswordEmailTemplete.ts
const sendResetPasswordEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 25px;">
    <img src="https://raw.githubusercontent.com/rakibislam2233/Image-Server/refs/heads/main/mentor-services.png" alt="Logo" style="width: 200px; margin-bottom: 20px;" />
    <h1 style="color: #1B9AAA;">Password Reset Request</h1>
  </div>
  
  <p>Dear <strong>{{name}}</strong>,</p>
  <p>We received a request to reset your password. Use the code below to proceed:</p>
  
  <div style="text-align: center; margin: 30px 0;">
    <h2 style="background-color: #f4f4f4; padding: 15px 25px; display: inline-block; border-radius: 8px; color: #1B9AAA; font-size: 32px; letter-spacing: 4px;">
      {{otp}}
    </h2>
  </div>

  <p>This code is valid for 10 minutes.</p>
  <p>If you did not request a password reset, please disregard this email.</p>

  <p>Best regards,<br/><strong>SplitRide Team</strong></p>
</div>
`;

export default sendResetPasswordEmail;