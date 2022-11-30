import {diff} from 'fast-array-diff';
import {
  useEffect,
  forwardRef,
  useCallback,
  useMemo,
  useId,
  useRef,
} from 'react';
import type {PartialDeep} from 'type-fest';
import {
  type Fetcher,
  useFetcher,
  useFetchers,
  useLocation,
} from '@remix-run/react';
import {useIsHydrated} from '~/hooks/useIsHydrated';
import invariant from 'tiny-invariant';
import {
  type ActionArgs,
  type HydrogenContext,
  redirect,
  json,
} from '@shopify/hydrogen-remix';
import type {
  Cart,
  CartInput,
  CartLine,
  CartLineInput,
  CartUserError,
  UserError,
} from '@shopify/hydrogen-react/storefront-api-types';
import React from 'react';
import {isLocalPath, usePrefixPathWithLocale} from '~/lib/utils';

interface LinesAddEventPayload {
  linesAdded: CartLineInput[];
  linesNotAdded?: CartLineInput[];
}

interface LinesAddEvent {
  type: 'lines_add';
  id: string;
  payload: LinesAddEventPayload;
}

interface CartLinesAddFormProps {
  lines: CartLineInput[] | [];
  optimisticLines?: PartialDeep<CartLine>[] | [];
  className?: string;
  children: ({
    state,
    errors,
  }: {
    state: 'idle' | 'submitting' | 'loading';
    errors: PartialDeep<UserError>[];
  }) => React.ReactNode;
  onSuccess?: (event: LinesAddEvent) => void;
}

interface OptimisticLinesAddingReturnType {
  optimisticLines: PartialDeep<CartLine>[] | [];
  optimisticLinesNew: PartialDeep<CartLine>[] | [];
}

interface LinesAddResponseProps {
  prevCart: Cart | null;
  cart: Cart;
  lines: CartLineInput[];
  formData: FormData;
  headers: Headers;
}

type DiffingLine = Pick<CartLine, 'id' | 'quantity'> & {
  merchandiseId: CartLine['merchandise']['id'];
};

interface DiffLinesProps {
  addingLines: CartLineInput[];
  prevLines: Cart['lines'];
  currentLines: Cart['lines'];
}

type LinesOptimisticLinesProps = Pick<
  CartLinesAddFormProps,
  'lines' | 'optimisticLines'
>;

interface UseCartLinesAddReturnType {
  cartLinesAdd: ({lines, optimisticLines}: LinesOptimisticLinesProps) => void;
  fetcher: Fetcher<any> | undefined;
}

// should match the path of the file
const ACTION_PATH = '/cart/CartLinesAdd';

/**
 * action that handles cart create (with lines) and lines add
 */
async function action({request, context}: ActionArgs) {
  const {session} = context;
  const headers = new Headers();

  const [formData, cartId] = await Promise.all([
    request.formData(),
    session.get('cartId'),
  ]);

  const lines = formData.get('lines')
    ? (JSON.parse(String(formData.get('lines'))) as CartLineInput[])
    : ([] as CartLineInput[]);
  invariant(lines.length, 'No lines to add');

  // Flow A — no previous cart, create and add line(s)
  if (!cartId) {
    const {cart, errors: graphqlErrors} = await cartCreate({
      input: {lines},
      context,
    });

    if (graphqlErrors?.length) {
      return json({errors: graphqlErrors});
    }

    // cart created - we only need a Set-Cookie header if we're creating
    session.set('cartId', cart.id);
    headers.set('Set-Cookie', await session.commit());

    return linesAddResponse({
      prevCart: null,
      cart,
      lines,
      formData,
      headers,
    });
  }

  /*
    for analytics we need to query the previous cart lines,
    so we can diff what was really added or not :(
    although it's slower, we now have optimistic lines add
  */
  const prevCart = await getCartLines({cartId, context});

  // Flow B — add line(s) to existing cart
  const {cart, errors: graphqlErrors} = await cartLinesAdd({
    cartId,
    lines,
    context,
  });

  if (graphqlErrors?.length) {
    return json({errors: graphqlErrors});
  }

  return linesAddResponse({prevCart, cart, lines, formData, headers});
}

/**
 * Helper function to handle linesAdd action responses
 * @returns action response
 */
function linesAddResponse({
  prevCart,
  cart,
  lines,
  formData,
  headers,
}: LinesAddResponseProps) {
  // if no js, we essentially reload to avoid being routed to the actions route
  const redirectTo = formData.get('redirectTo') ?? null;
  if (typeof redirectTo === 'string' && isLocalPath(redirectTo)) {
    return redirect(redirectTo, {headers});
  }

  const prevLines = (prevCart?.lines || []) as Cart['lines'];

  // create analytics event payload
  const {event, errors} = instrumentEvent({
    addingLines: lines,
    prevLines,
    currentLines: cart.lines,
  });

  return json({event, errors}, {headers});
}

/**
 * helper function to instrument lines_add | lines_add_error events
 * @param addingLines - line inputs being added
 * @param prevLines - lines before the mutation
 * @param currentLines - lines after the mutation
 * @returns {event, error}
 */
function instrumentEvent({
  addingLines,
  currentLines,
  prevLines,
}: DiffLinesProps) {
  // diff lines for analytics
  const {linesAdded, linesNotAdded} = diffLines({
    addingLines,
    prevLines,
    currentLines,
  });

  const event = {
    type: 'lines_add',
    id: crypto.randomUUID(),
    payload: {
      linesAdded,
    },
  };

  let errors: PartialDeep<UserError>[] = [];

  if (linesNotAdded.length) {
    errors = linesNotAdded.map((line) => ({
      code: 'LINE_NOT_ADDED',
      message: line.merchandiseId.split('/').pop(),
    }));
  }

  return {event, errors};
}

/**
 * Diff prev lines with current lines to determine what was added
 * This is a temporary workaround for analytics until we land
 * @see: https://github.com/Shopify/storefront-api-feedback/discussions/151
 * @todo: remove when storefront api releases this feature
 * @param addingLines - line inputs being added
 * @param prevLines - lines before the mutation
 * @param currentLines - lines after the mutation
 * @returns {linesAdded, linesNotAdded}
 */
function diffLines({addingLines, prevLines, currentLines}: DiffLinesProps) {
  const prev: DiffingLine[] =
    prevLines?.edges?.map(({node: {id, quantity, merchandise}}) => ({
      id,
      quantity,
      merchandiseId: merchandise.id,
    })) || [];

  const next: DiffingLine[] =
    currentLines?.edges?.map(({node: {id, quantity, merchandise}}) => ({
      id,
      quantity,
      merchandiseId: merchandise.id,
    })) || [];

  // lines comparison function
  function comparer(prevLine: DiffingLine, line: DiffingLine) {
    return (
      prevLine.id === line.id &&
      prevLine.merchandiseId === line.merchandiseId &&
      line.quantity <= prevLine.quantity
    );
  }

  const {added} = diff(prev, next, comparer);
  const linesAdded = added || [];
  const linesAddedIds = linesAdded?.map(({merchandiseId}) => merchandiseId);
  const linesNotAdded =
    addingLines?.filter(({merchandiseId}) => {
      return !linesAddedIds.includes(merchandiseId);
    }) || [];

  return {linesAdded, linesNotAdded};
}

/*
  action mutations & queries -----------------------------------------------------------------------------------------
*/
const USER_ERROR_FRAGMENT = `#graphql
  fragment ErrorFragment on CartUserError {
    message
    field
    code
  }
`;

const LINES_CART_FRAGMENT = `#graphql
  fragment CartLinesFragment on Cart {
    id
    totalQuantity
    lines(first: 100) {
      edges {
        node {
          id
          quantity
          merchandise {
            ...on ProductVariant {
              id
            }
          }
        }
      }
    }
  }
`;

const CART_LINES_QUERY = `#graphql
  query ($cartId: ID!, $country: CountryCode = ZZ, $language: LanguageCode)
  @inContext(country: $country, language: $language) {
    cart(id: $cartId) {
      ...CartLinesFragment
    }
  }
  ${LINES_CART_FRAGMENT}
`;

// @see: https://shopify.dev/api/storefront/2022-01/mutations/cartcreate
const CREATE_CART_MUTATION = `#graphql
  mutation ($input: CartInput!, $country: CountryCode = ZZ, $language: LanguageCode)
  @inContext(country: $country, language: $language) {
    cartCreate(input: $input) {
      cart {
        ...CartLinesFragment
      }
      errors: userErrors {
        ...ErrorFragment
      }
    }
  }
  ${LINES_CART_FRAGMENT}
  ${USER_ERROR_FRAGMENT}
`;

const ADD_LINES_MUTATION = `#graphql
  mutation ($cartId: ID!, $lines: [CartLineInput!]!, $country: CountryCode = ZZ, $language: LanguageCode)
  @inContext(country: $country, language: $language) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        ...CartLinesFragment
      }
      errors: userErrors {
        ...ErrorFragment
      }
    }
  }
  ${LINES_CART_FRAGMENT}
  ${USER_ERROR_FRAGMENT}
`;

/**
 * Fetch the current cart lines
 * @param cartId
 * @see https://shopify.dev/api/storefront/2022-01/queries/cart
 * @returns cart query result
 */
async function getCartLines({
  cartId,
  context,
}: {
  cartId: string;
  context: HydrogenContext;
}) {
  const {storefront} = context;
  invariant(storefront, 'missing storefront client in cart create mutation');

  const {cart} = await storefront.query<{cart: Cart}>(CART_LINES_QUERY, {
    variables: {
      cartId,
    },
    cache: storefront.CacheNone(),
  });

  invariant(cart, 'No data returned from cart lines query');
  return cart;
}

/**
 * Create a cart with line(s) mutation
 * @param input CartInput https://shopify.dev/api/storefront/2022-01/input-objects/CartInput
 * @see https://shopify.dev/api/storefront/2022-01/mutations/cartcreate
 * @returns mutated cart
 */
async function cartCreate({
  input,
  context,
}: {
  input: CartInput;
  context: HydrogenContext;
}) {
  const {storefront} = context;
  invariant(storefront, 'missing storefront client in cartCreate mutation');

  const {cartCreate} = await storefront.mutate<{
    cartCreate: {
      cart: Cart;
      errors: CartUserError[];
    };
    errors: UserError[];
  }>(CREATE_CART_MUTATION, {
    variables: {input},
  });

  invariant(cartCreate, 'No data returned from cartCreate mutation');

  return cartCreate;
}

/**
 * Storefront API cartLinesAdd mutation
 * @param cartId
 * @param lines [CartLineInput!]! https://shopify.dev/api/storefront/2022-01/input-objects/CartLineInput
 * @see https://shopify.dev/api/storefront/2022-01/mutations/cartLinesAdd
 * @returns mutated cart
 */
async function cartLinesAdd({
  cartId,
  lines,
  context,
}: {
  cartId: string;
  lines: CartLineInput[];
  context: HydrogenContext;
}) {
  const {storefront} = context;
  invariant(storefront, 'missing storefront client in cartLinesAdd mutation');

  const {cartLinesAdd} = await storefront.mutate<{
    cartLinesAdd: {
      cart: Cart;
      errors: CartUserError[];
    };
  }>(ADD_LINES_MUTATION, {
    variables: {cartId, lines},
  });

  invariant(cartLinesAdd, 'No data returned from cartLinesAdd mutation');

  return cartLinesAdd;
}

/**
 * Form that adds line(s) to the cart
 * @param lines an array of line(s) to add. CartLineInput[]
 * @param optimisticLines an array of cart line(s) being added. CartLine[]
 * @param children render submit button
 * @param onSuccess? callback that runs after each form submission
 */
const CartLinesAddForm = forwardRef<HTMLFormElement, CartLinesAddFormProps>(
  ({children, lines = [], optimisticLines = [], onSuccess, className}, ref) => {
    const formId = useId();
    const lastEventId = useRef<string | undefined>();
    const {pathname, search} = useLocation();
    const fetcher = useFetcher();
    const isHydrated = useIsHydrated();
    const errors = fetcher?.data?.errors;
    const event = fetcher?.data?.event;
    const eventId = fetcher?.data?.event?.id;
    const localizedActionPath = usePrefixPathWithLocale(ACTION_PATH);
    const localizedCurrentPath = usePrefixPathWithLocale(
      `${pathname}${search}`,
    );

    useEffect(() => {
      if (!eventId) return;
      if (eventId === lastEventId.current) return;
      onSuccess?.(event);
      lastEventId.current = eventId;
    }, [eventId, event, onSuccess]);

    if (!Array.isArray(lines) || !lines?.length) {
      return null;
    }

    return (
      <fetcher.Form
        id={formId}
        method="post"
        action={localizedActionPath}
        className={className}
        ref={ref}
      >
        {Array.isArray(lines) && (
          <input
            type="hidden"
            name="lines"
            defaultValue={JSON.stringify(lines)}
          />
        )}
        {Array.isArray(optimisticLines) && (
          <input
            type="hidden"
            name="optimisticLines"
            defaultValue={JSON.stringify(optimisticLines)}
          />
        )}
        {/* used to trigger a redirect back to the PDP when JS is disabled */}
        {isHydrated ? null : (
          <input
            type="hidden"
            name="redirectTo"
            defaultValue={localizedCurrentPath}
          />
        )}
        {children({state: fetcher.state, errors})}
      </fetcher.Form>
    );
  },
);

/**
 * A hook version of CartLinesAddForm to add cart line(s) programmatically
 * @param onSuccess callback function that executes on success
 * @returns { cartLinesAdd, fetcher }
 */
function useCartLinesAdd(
  onSuccess: (event: LinesAddEvent) => void = () => {},
): UseCartLinesAddReturnType {
  const fetcher = useFetcher();
  const lastEventId = useRef<string | undefined>();
  const localizedActionPath = usePrefixPathWithLocale(ACTION_PATH);

  const cartLinesAdd = useCallback(
    ({lines = [], optimisticLines = []}: LinesOptimisticLinesProps) => {
      const form = new FormData();
      Array.isArray(lines) && form.set('lines', JSON.stringify(lines));
      Array.isArray(optimisticLines) &&
        form.set('optimisticLines', JSON.stringify(optimisticLines));

      fetcher.submit(form, {
        method: 'post',
        action: localizedActionPath,
        replace: false,
      });
    },
    [fetcher, localizedActionPath],
  );

  useEffect(() => {
    if (!fetcher?.data?.event) return;
    if (lastEventId.current === fetcher?.data?.event?.id) return;
    onSuccess?.(fetcher.data.event);
    lastEventId.current = fetcher.data.event.id;
  }, [fetcher?.data?.event, onSuccess]);

  return {cartLinesAdd, fetcher};
}

/**
 * Utility hook to get an active lines adding fetcher
 * @returns fetcher
 */
function useCartLinesAddingFetcher() {
  const localizedActionPath = usePrefixPathWithLocale(ACTION_PATH);

  const fetchers = useFetchers();
  return fetchers.find(
    (fetcher) => fetcher?.submission?.action === localizedActionPath,
  );
}

/**
 * A utility hook to get the current lines being added
 * @param onSuccess callback function that executes on success
 * @returns { linesAdding, fetcher }
 */
function useCartLinesAdding() {
  const fetcher = useCartLinesAddingFetcher();

  let linesAdding: CartLineInput[] = [];

  const linesStr = fetcher?.submission?.formData?.get('lines');
  if (linesStr && typeof linesStr === 'string') {
    try {
      linesAdding = JSON.parse(linesStr);
    } catch (_) {
      // no-op
    }
  }

  return {linesAdding, fetcher};
}

/**
 * A utility hook to get the optimistic lines being added
 * @param lines CartLine[] | undefined
 * @returns {optimisticLines: [], optimisticLinesNew: []}
 */
function useOptimisticCartLinesAdding(
  lines?: PartialDeep<CartLine, {recurseIntoArrays: true}>[] | unknown,
): OptimisticLinesAddingReturnType {
  const fetcher = useCartLinesAddingFetcher();
  const optimisticLinesStr =
    fetcher?.submission?.formData?.get('optimisticLines');

  // parse all lines currently added and filter new ones
  return useMemo(() => {
    let optimisticLines: PartialDeep<CartLine>[] | [] = [];
    const optimisticLinesNew: PartialDeep<CartLine>[] | [] = [];

    // get optimistic lines currently being added
    if (optimisticLinesStr && typeof optimisticLinesStr === 'string') {
      optimisticLines = JSON.parse(optimisticLinesStr);
    } else {
      return {optimisticLines, optimisticLinesNew};
    }

    // default return
    const result: OptimisticLinesAddingReturnType = {
      optimisticLines,
      optimisticLinesNew,
    };

    // not adding optimistic lines
    if (!optimisticLines?.length) return result;

    // no existing lines, all adding are new
    if (!Array.isArray(lines) || !lines?.length) {
      result.optimisticLinesNew = optimisticLines;
      return result;
    }

    // lines comparison function
    function comparer(
      prevLine: PartialDeep<CartLine>,
      line: PartialDeep<CartLine>,
    ) {
      if (typeof prevLine?.merchandise?.id === 'undefined') return false;
      if (typeof line?.merchandise?.id === 'undefined') return false;
      return prevLine.merchandise.id === line.merchandise.id;
    }

    const {added} = diff(lines, optimisticLines, comparer);

    result.optimisticLinesNew = added;
    return result;
  }, [optimisticLinesStr, lines]);
}

export {
  action,
  cartCreate,
  cartLinesAdd,
  CartLinesAddForm,
  getCartLines,
  LINES_CART_FRAGMENT, // @todo: would be great if these lived in a shared graphql/ folder
  useCartLinesAdd,
  useCartLinesAdding,
  useOptimisticCartLinesAdding,
  USER_ERROR_FRAGMENT, // @todo: would be great if these lived in a shared graphql/ folder
};
