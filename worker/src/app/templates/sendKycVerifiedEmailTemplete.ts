// sendKycVerifiedEmailTemplete.ts
const sendKycSuccessEmail = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 25px;">
    <h1 style="color: #28a745; margin: 0;">Congratulations! 🎉</h1>
  </div>
  
  <p>Dear <strong>{{name}}</strong>,</p>
  
  <p>Your KYC verification has been successfully <strong>approved</strong>.</p>

  <div style="background: #f8fff9; border-left: 5px solid #28a745; padding: 15px 20px; margin: 25px 0; border-radius: 6px;">
    <p><strong>Status:</strong> ✅ Verified</p>
    <p><strong>Approved On:</strong> ${new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })}</p>
  </div>

  <p>You can now access all features including ride requests, payments, and more.</p>

  <p>Best regards,<br/><strong>Team SplitRide</strong></p>
</div>
`;

export default sendKycSuccessEmail;