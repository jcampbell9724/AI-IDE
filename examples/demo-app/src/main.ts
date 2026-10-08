import './styles.css';

const menuToggle = document.querySelector<HTMLButtonElement>('#menu-toggle');
const navigation = document.querySelector<HTMLElement>('#primary-navigation');

function setMenuOpen(open: boolean): void {
  if (!menuToggle || !navigation) return;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('is-open', open);
  document.body.classList.toggle('menu-open', open);
}

menuToggle?.addEventListener('click', () => {
  setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
});

navigation?.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('a')) setMenuOpen(false);
});

window.addEventListener('resize', () => {
  if (window.innerWidth >= 760) setMenuOpen(false);
});

const form = document.querySelector<HTMLFormElement>('#early-access-form');
const emailInput = document.querySelector<HTMLInputElement>('#email-input');
const formStatus = document.querySelector<HTMLElement>('#form-status');
const submitButton = document.querySelector<HTMLButtonElement>('#form-submit');

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!emailInput || !formStatus || !submitButton) return;

  if (!emailInput.validity.valid) {
    formStatus.textContent = 'Enter a valid work email to join the list.';
    formStatus.classList.remove('is-success');
    formStatus.classList.add('is-error');
    emailInput.setAttribute('aria-invalid', 'true');
    emailInput.focus();
    return;
  }

  emailInput.removeAttribute('aria-invalid');
  formStatus.textContent = `You’re on the list, ${emailInput.value}. We’ll be in touch.`;
  formStatus.classList.remove('is-error');
  formStatus.classList.add('is-success');
  submitButton.textContent = 'You’re in ✓';
  submitButton.disabled = true;
  emailInput.disabled = true;
});

const currentYear = document.querySelector<HTMLElement>('#current-year');
if (currentYear) currentYear.textContent = String(new Date().getFullYear());
