export const generateTransactionId = (): string => {
  const date = new Date();

  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  const randomPart = Math.floor(10000 + Math.random() * 90000); // Generates 5-digit number

  const transactionId = `SplitRide-${year}${month}${day}-${randomPart}`;

  return transactionId;
};