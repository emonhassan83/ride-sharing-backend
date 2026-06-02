import { ISendEmail } from '@/app/@types/system.types';

export function mailOption(
  to: string,
  subject: string,
  html: string
): ISendEmail {
  const option: ISendEmail = {
    to,
    subject,
    html,
  };
  return option;
}
