import Stripe from 'stripe';
import { config } from './env.config';
import { User } from '../modules/user/user.model';

class StripeService {
  // Stripe class instance type
  private stripeInstance: InstanceType<typeof Stripe>;

  constructor() {
    this.stripeInstance = new Stripe(config.pay?.secretKey as string, {
      apiVersion: '2026-05-27.dahlia',
      typescript: true,
    });
  }

  private stripe(): InstanceType<typeof Stripe> {
    return this.stripeInstance;
  }

  private handleError(error: unknown, message: string): never {
    // StripeError type check and logging
    if (error instanceof Error && 'type' in error && error.constructor.name === 'StripeError') {
      console.error('Stripe Error:', error.message);
      throw new Error(`Stripe Error: ${message} - ${error.message}`);
    } else if (error instanceof Error) {
      console.error('Error:', error.message);
      throw new Error(`${message} - ${error.message}`);
    } else {
      console.error('Unknown Error:', error);
      throw new Error(`${message} - An unknown error occurred.`);
    }
  }

  public async connectAccount(
    returnUrl: string,
    refreshUrl: string,
    accountId: string,
  ) {
    try {
      const accountLink = await this.stripe().accountLinks.create({
        account: accountId,
        return_url: returnUrl,
        refresh_url: refreshUrl,
        type: 'account_onboarding',
      });
      return accountLink;
    } catch (error) {
      this.handleError(error, 'Error connecting account');
    }
  }

  public async createPaymentIntent(
    amount: number,
    currency: string,
    payment_method_types: string[] = ['card'],
  ) {
    try {
      return await this.stripe().paymentIntents.create({
        amount: amount * 100,
        currency,
        payment_method_types,
      });
    } catch (error) {
      this.handleError(error, 'Error creating payment intent');
    }
  }

  public async transfer(
    amount: number,
    accountId: string,
    currency: string = 'usd',
  ) {
    try {
      const balance = await this.stripe().balance.retrieve();

      // Fixed: 'bal' type defined for better type safety
      const availableBalance = balance.available.reduce(
        (total: number, bal: { amount: number }) => total + bal.amount,
        0,
      );

      if (availableBalance < amount) {
        throw new Error('Insufficient funds to cover the transfer.');
      }

      return await this.stripe().transfers.create({
        amount,
        currency,
        destination: accountId,
      });
    } catch (error) {
      this.handleError(error, 'Error transferring funds');
    }
  }

  public async refund(payment_intent: string, amount: number) {
    try {
      return await this.stripe().refunds.create({
        payment_intent,
        amount: Math.round(amount),
      });
    } catch (error) {
      this.handleError(error, 'Error processing refund');
    }
  }

  public async retrieve(session_id: string) {
    try {
      return await this.stripe().checkout.sessions.retrieve(session_id);
    } catch (error) {
      this.handleError(error, 'Error retrieving session');
    }
  }

  public async getPaymentStatus(session_id: string) {
    try {
      const session = await this.stripe().checkout.sessions.retrieve(session_id);
      return session.status;
    } catch (error) {
      this.handleError(error, 'Error retrieving payment status');
    }
  }

  public async isPaymentSuccess(session_id: string): Promise<boolean> {
    try {
      const session = await this.stripe().checkout.sessions.retrieve(session_id);
      return session.status === 'complete';
    } catch (error) {
      this.handleError(error, 'Error checking payment success');
      return false; 
    }
  }

  public getStripe() {
    return this.stripe();
  }

  public async connectExistingAccount(
    userId: string,
    payload: { stripeAccountId: string }
  ) {
    const { stripeAccountId } = payload;

    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      throw new Error('Invalid Stripe Account ID. It must start with "acct_"');
    }

    try {
      await this.stripe().accounts.retrieve(stripeAccountId);

      await User.findByIdAndUpdate(userId, { stripeAccountId });

      const refreshUrl = `${config.server.url}/stripe/refresh/${stripeAccountId}?userId=${userId}`;
      const returnUrl = `${config.server.url}/stripe/return?userId=${userId}&stripeAccountId=${stripeAccountId}`;

      const accountLink = await this.connectAccount(returnUrl, refreshUrl, stripeAccountId);

      if (!accountLink) throw new Error('Failed to generate account onboarding link.');

      return {
        success: true,
        isNewAccount: false,
        accountId: stripeAccountId,
        url: accountLink.url,
        message: 'Your existing Stripe account has been connected successfully!',
      };
    } catch (error) {
      this.handleError(error, 'Error connecting existing Stripe account');
    }
  }
}

export default new StripeService();