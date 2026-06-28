import httpStatus from 'http-status';
import { User } from '../user/user.model';
import StripeService from '../../config/stripe.config';
import ApiError from '../../errors/ApiError';
import { TCardList } from './card.interface';
import { TUser } from '../user/user.interface';

const stripe = StripeService.getStripe();

/* =====================================================
   🔹 ATTACH PAYMENT METHOD & SET AS DEFAULT
===================================================== */

const createStripeCustomer = async (user: TUser): Promise<string> => {
  // If exist customer then return
  if (user.customerId) return user.customerId;

  // Stripe- new customer create
  const customer = await StripeService.getStripe().customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      userId: user._id.toString(),
    },
  });

  // User Model- save customerID
  await User.findByIdAndUpdate(user._id, {
    customerId: customer.id,
  });

  return customer.id;
};

const setupInitiate = async (payload: {
  paymentMethodId: string
}, userId: string) => {
  const { paymentMethodId } = payload;

  try {
    const user = await User.findById(userId);
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

  // create customerId
  const customerId = await createStripeCustomer(user);

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    return {
      success: true,
      message: 'Payment method attached and set as default successfully',
    };
  } catch (error: any) {
    console.error('Setup Initiate Error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Failed to setup payment method');
  }
};

/* =====================================================
   🔹 GET ALL CARDS OF USER
===================================================== */
const getCardList = async (userId: string): Promise<TCardList[]> => {
  try {
    const user = await User.findById(userId).select('customerId name email');
    if (!user) throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

    if (!user.customerId) return [];

    const customer = await stripe.customers.retrieve(user.customerId);

    const paymentMethods = await stripe.paymentMethods.list({
      customer: user.customerId,
      type: 'card',
    });

    const cardList: TCardList[] = paymentMethods.data.map((item) => ({
      id: item.id,
      type: item.type,
      brand: item.card?.display_brand || item.card?.brand || '',
      last4: item.card?.last4 || '',
      expMonth: item.card?.exp_month || 0,
      expYear: item.card?.exp_year || 0,
      funding: item.card?.funding || '',
      country: item.card?.country || '',
      isDefault: ('invoice_settings' in customer) && customer.invoice_settings?.default_payment_method === item.id,
    }));

    return cardList;
  } catch (error: any) {
    console.error('Get Card List Error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Failed to fetch cards');
  }
};

/* =====================================================
   🔹 DELETE CARD
===================================================== */
const deleteCard = async (cardId: string, userId: string) => {
  try {
    const user = await User.findById(userId).select('customerId');
    if (!user || !user.customerId) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User or Customer ID not found');
    }

    // Verify card belongs to this customer
    const paymentMethod = await stripe.paymentMethods.retrieve(cardId);
    if (paymentMethod.customer !== user.customerId) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This card does not belong to you');
    }

    // Detach card
    await stripe.paymentMethods.detach(cardId);

    return {
      success: true,
      message: 'Card deleted successfully',
    };
  } catch (error: any) {
    console.error('Delete Card Error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Failed to delete card');
  }
};

/* =====================================================
   🔹 SET DEFAULT CARD
===================================================== */
const setDefaultCard = async (paymentMethodId: string, userId: string) => {
  try {
    const user = await User.findById(userId).select('customerId');
    if (!user || !user.customerId) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User or Customer ID not found');
    }

    // Verify card belongs to customer
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (paymentMethod.customer !== user.customerId) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This card does not belong to you');
    }

    // Set as default
    await stripe.customers.update(user.customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    return {
      success: true,
      message: 'Default card updated successfully',
    };
  } catch (error: any) {
    console.error('Set Default Card Error:', error);
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Failed to set default card');
  }
};

export const CardServices = {
  setupInitiate,
  getCardList,
  deleteCard,
  setDefaultCard,
};
