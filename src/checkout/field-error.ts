import { Platform } from 'react-native';

export function fieldErrorProps(invalid: boolean, messageId: string) {
  return Platform.OS === 'web' && invalid
    ? { 'aria-invalid': true, 'aria-describedby': messageId } as const
    : {};
}
