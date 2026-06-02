import { Schema, model } from 'mongoose'
import { TFaq, TFaqModel } from './faq.interface'
import { AUDIENCE } from './faq.constant'

const faqSchema = new Schema<TFaq>(
  {
    audience: { type: String, enum: Object.values(AUDIENCE), required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
  },
  {
    timestamps: true,
  },
)

export const Faq = model<TFaq, TFaqModel>('Faq', faqSchema)
