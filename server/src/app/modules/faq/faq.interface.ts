import { Model } from 'mongoose'
import { TAudience } from './faq.constant'

export type TFaq = {
  _id?: string
  audience: TAudience
  question: string
  answer: string
}

export type TFaqModel = Model<TFaq, Record<string, unknown>>
