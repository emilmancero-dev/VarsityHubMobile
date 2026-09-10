import { Alert } from 'react-native';
import { showUploadErrorAlert } from '@/utils/uploadErrorAlert';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

describe('upload error disclosure', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  beforeEach(() => alert.mockClear());
  afterAll(() => alert.mockRestore());

  it('replaces the screenshot native error with the story fallback', () => {
    showUploadErrorAlert(
      new Error('The operation couldn’t be completed. (PHPhotosErrorDomain error 3164.)'),
      {
        fallbackTitle: 'Unable to add story',
        fallbackMessage: 'Please try again.',
      }
    );
    expect(alert).toHaveBeenCalledWith('Unable to add story', 'Please try again.');
  });

  it.each([502, 500, 413, 400])('never displays provider diagnostic text for status %s', status => {
    showUploadErrorAlert({ status, message: 'private-value provider error' });
    expect(alert).toHaveBeenCalled();
    expect(JSON.stringify(alert.mock.calls)).not.toContain('private-value');
  });

  it('keeps actionable network feedback', () => {
    showUploadErrorAlert({ status: 0, isNetworkError: true, message: 'private-value' });
    expect(alert).toHaveBeenCalledWith(
      'Connection Problem',
      "Couldn't reach the server. Check your connection and try again."
    );
  });
});
