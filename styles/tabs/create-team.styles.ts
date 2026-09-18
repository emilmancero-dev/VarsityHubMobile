import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  // Intro Card
  introCard: {
    margin: 16,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
  },
  limitCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  limitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  limitBadge: {
    fontSize: 12,
    fontWeight: '700',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  limitUpgradeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  limitUpgradeText: {
    fontWeight: '600',
  },
  limitTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  limitDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  introIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  introTitle: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  introSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Form
  formSection: {
    paddingHorizontal: 16,
  },
  fieldGroup: {
    marginBottom: 24,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  charCount: {
    fontSize: 13,
    fontWeight: '500',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    marginLeft: 12,
  },
  // Sport chips
  chipButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  clubTypeContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  clubTypeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    position: 'relative',
  },
  clubTypeText: {
    fontSize: 15,
    fontWeight: '600',
  },
  legendBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  legendBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
    textTransform: 'uppercase',
  },
  // Season grid
  seasonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  seasonButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    minWidth: '47%',
  },
  seasonButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // Description
  textAreaContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 100,
  },
  textArea: {
    fontSize: 16,
    textAlignVertical: 'top',
    minHeight: 80,
  },
  // Action
  actionSection: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  limitWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  limitWarningText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: 'transparent', // Will be overridden with theme color
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: 16,
    gap: 8,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  // Logo styles
  logoSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  logoContainer: {
    width: 80,
    height: 80,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  logoPlaceholderText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  logoActions: {
    flex: 1,
    gap: 8,
  },
  logoActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  logoActionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  fieldHint: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  // Year input styles
  yearInputContainer: {
    gap: 8,
  },
  fieldLabelSmall: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  yearInput: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    justifyContent: 'center',
  },
  yearInputText: {
    fontSize: 16,
    fontWeight: '600',
  },
  seasonPreview: {
    fontSize: 14,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  colorButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 4,
        }),
  },
  colorPreview: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  orgPickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  orgPickerContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  orgPickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  orgPickerHeaderButton: {
    fontSize: 16,
    fontWeight: '600',
  },
  orgPickerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  orgPickerSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  orgPickerSearchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  orgPickerList: {
    maxHeight: 400,
  },
  orgPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  orgPickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  orgPickerItemText: {
    fontSize: 16,
  },
  orgPickerEmpty: {
    padding: 32,
    alignItems: 'center',
    gap: 12,
  },
  orgPickerEmptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
