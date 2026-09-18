import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    marginBottom: 20,
  },
  bannerCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  bannerHelperText: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  customBannerImage: {
    width: '100%',
    height: 180,
    borderRadius: 10,
  },
  bannerActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bannerPrimaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  bannerPrimaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  bannerSecondaryButton: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  bannerSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  generatedBannerLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typeButton: {
    flex: 1,
    minWidth: '48%',
    padding: 12,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: 'center',
    gap: 4,
  },
  typeButtonActive: {
    borderWidth: 2,
  },
  typeEmoji: {
    fontSize: 28,
  },
  typeLabel: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
  },
  textArea: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 100,
  },
  dateTimeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dateTimeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  dateTimeText: {
    fontSize: 16,
    flex: 1,
  },
  gameTypeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  gameTypeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 2,
  },
  gameTypeText: {
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 12,
    color: '#DC2626',
    marginTop: 4,
  },
  infoBox: {
    flexDirection: 'row',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    marginBottom: 20,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  submitButton: {
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  pickerContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  pickerSheet: {
    flex: 1,
  },
  pickerSearchWrap: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pickerSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  pickerSearchInput: {
    flex: 1,
    fontSize: 16,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  pickerHeaderButton: {
    fontSize: 16,
    fontWeight: '600',
  },
  pickerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  pickerList: {
    maxHeight: 400,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  pickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  teamLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  pickerItemText: {
    fontSize: 16,
  },
  noResultsContainer: {
    padding: 32,
    alignItems: 'center',
  },
  noResultsText: {
    fontSize: 14,
    textAlign: 'center',
  },
  locationFieldWrapper: {
    position: 'relative',
  },
  locationSpinner: {
    position: 'absolute',
    right: 12,
    top: 12,
  },
  locationSuggestionList: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: 200,
    zIndex: 1000,
    elevation: 5,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.1,
          shadowRadius: 4,
        }),
  },
  locationSuggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
  },
  locationSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  locationSuggestionMain: {
    fontSize: 15,
    fontWeight: '500',
  },
  locationSuggestionSecondary: {
    fontSize: 13,
    marginTop: 2,
  },
  inputHelperText: {
    fontSize: 12,
    marginTop: 4,
  },
  suggestionsBox: {
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 4,
    overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  suggestionText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
